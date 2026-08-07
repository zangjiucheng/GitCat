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
import { ICON_BACKUP, ICON_WARNING } from "../../legacy/icons";
import { copyToClipboard } from "../../legacy/clipboard.ts";
import type { LocalBranch, SimpleRef, Snapshot, SubmoduleInfo } from "../../ipc/bindings";

// A branch older than this (its own tip's last_commit_time) is hidden by
// Auto mode's recomputeAutoVisibility, below, even when merge status can't
// rule it "merged". Covers a real report ("Auto still shows almost all
// branches") that the merge-status check alone can't fix: a repo whose local
// branches are long-lived, INTENTIONALLY parallel release/maintenance lines
// (e.g. "3.10"/"3.11"/"3.13" alongside "main" in a large real project) never
// becomes "merged into default" for any of them — they're permanently
// siblings of default, not ancestors of it, by design — so every one stayed
// visible forever under the old merge-only heuristic regardless of whether
// anyone was actually still touching it. 90 days is generous on purpose: a
// maintenance branch legitimately going quiet between occasional
// backport/security-fix commits shouldn't disappear just for resting.
const STALE_DAYS = 90;

// FOLLOW-UP FIX ("Auto still isn't smart enough"): STALE_DAYS alone is a hard
// yes/no cliff (a branch touched 89 days ago and one touched 91 days ago land
// in totally different buckets despite being practically identical) AND has
// no upper bound at all — a repo with, say, 30 branches that are all
// individually "recent enough and technically unmerged" just shows all 30,
// which is exactly the clutter Auto mode exists to avoid. recomputeAutoVisibility
// now ranks the "recent-but-unmerged" set by a smooth recency score (frecency-
// style exponential decay, same idea browsers use to rank URL-bar history)
// instead of a boolean, and keeps only the top MAX_AUTO_CANDIDATES of them.
// RECENCY_HALF_LIFE_DAYS: a branch's score halves every this-many days since
// its last commit — 14 days means "touched two weeks ago" scores half of
// "touched today", smoothly, rather than the old all-or-nothing cliff.
// MIN_RECENCY is deliberately anchored to the OLD STALE_DAYS cutoff (the
// score a branch would have at exactly 90 days old) rather than picked
// independently — this keeps the pass/fail boundary for a repo with few
// candidates (nothing to rank/cap) identical to before; the cap below is
// what's actually new. This ONLY applies to the "recent-but-unmerged" tier —
// the current branch and anything with unpushed commits are kept
// unconditionally, same guarantee as before (see the "always" tier in
// recomputeAutoVisibility), never subject to this cap.
const RECENCY_HALF_LIFE_DAYS = 14;
const MIN_RECENCY = Math.pow(0.5, STALE_DAYS / RECENCY_HALF_LIFE_DAYS);
const MAX_AUTO_CANDIDATES = 10;

// Demo data (design-mode only) — mirrors the static markup this replaces, so
// the browser preview still shows a populated sidebar without a real repo.
// lastCommitTime: fabricated relative to whenever the browser preview
// happens to load (module-eval time is fine — this is cosmetic demo data,
// never compared for real staleness the way a live repo's would be), spread
// across recent-to-stale so recomputeAutoVisibility's own STALE_DAYS cutoff
// (see its doc comment) has something real to demonstrate: release/0.3 here
// is intentionally old enough to fall on the "hidden" side.
const DEMO_LOCALS: LocalBranch[] = [
  { name: "main", sha: "a1b2c3d", ahead: 2, behind: null, upstream: "origin/main", lastCommitTime: Date.now() / 1000 - 2 * 3600 },
  { name: "feat/inline-diff", sha: "b2c3d4e", ahead: null, behind: 3, upstream: "origin/feat/inline-diff", lastCommitTime: Date.now() / 1000 - 5 * 86400 },
  { name: "fix/lane-cull", sha: "c3d4e5f", ahead: null, behind: null, upstream: null, lastCommitTime: Date.now() / 1000 - 1 * 86400 },
  { name: "release/0.3", sha: "d4e5f60", ahead: null, behind: null, upstream: null, lastCommitTime: Date.now() / 1000 - 200 * 86400 },
  // Two more release lines so the ref tree's numeric ordering (see
  // compareRefLabels) has something real to demonstrate, the same way
  // release/0.3's own timestamp above demonstrates Auto's staleness cutoff:
  // `1.9` must sort BEFORE `1.10`, which plain lexicographic ordering gets
  // backwards.
  { name: "release/1.9", sha: "d4e5f61", ahead: null, behind: null, upstream: null, lastCommitTime: Date.now() / 1000 - 30 * 86400 },
  { name: "release/1.10", sha: "d4e5f62", ahead: null, behind: null, upstream: null, lastCommitTime: Date.now() / 1000 - 12 * 86400 },
];
const DEMO_REMOTES: SimpleRef[] = [
  { name: "origin/main", sha: "a1b2c3d" },
  { name: "origin/feat/inline-diff", sha: "b2c3d4e" },
  { name: "origin/topic/rerere", sha: "e5f6071" },
  { name: "upstream/main", sha: "f60718a" },
  { name: "upstream/dev", sha: "60718a9" },
  // A second remote tracking the SAME branch name as origin — a `feat/` folder
  // under each remote's own node. Deliberate: their collapse state has to stay
  // separate, and this is what a fork configured with an upstream looks like.
  { name: "upstream/feat/inline-diff", sha: "b2c3d4e" },
];
const DEMO_TAGS: SimpleRef[] = [
  { name: "v0.3.0", sha: "a1b2c3d" },
  { name: "v0.2.0", sha: "718a9bc" },
  { name: "nightly-2026-07-05", sha: "18a9bcd" },
  // Release candidates under a shared prefix — tags are grouped by the same
  // "/" tree as branches, and without a path-like tag here the preview would
  // never show that.
  { name: "v1.0/rc1", sha: "8a9bcde" },
  { name: "v1.0/rc2", sha: "a9bcdef" },
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

export type BranchMenu = { name: string; isCurrent: boolean; upstream: string | null; x: number; y: number };
// Tags never have an "isCurrent" concept (you don't "check out" a tag in this
// app — see sidebarCtrl.deleteTag's own doc comment), so this is intentionally
// a separate, smaller shape rather than reusing BranchMenu with a dummy field.
export type TagMenu = { name: string; x: number; y: number };
// A submodule row used to render up to 5 always-visible inline buttons
// (Open/Sync/Init+update-or-Update/Deinit/Remove) plus its status chip and
// path — at the sidebar's normal width these simply don't fit and got
// silently clipped (found via visual inspection, not a report). Fixed by
// collapsing everything but the row itself (click = Open, same as a branch
// row's own click jumps the graph to that ref's tip) into a "⋮" popover,
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
// "Push to…" popover, opened from the branch popover's own "Push to…"
// button (see `openPushMenu`) — same shape/rationale as MergeMenu above; the
// target remote branch name itself lives in `pushBranchInput` (a normal
// bound `$state` string, not part of this type) rather than here, since it
// needs to be a live-editable input value, not a snapshot captured at open
// time the way `name`/`x`/`y` are.
export type PushMenu = { name: string; x: number; y: number };
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
// A branch row's click/Enter jumps the graph to that ref's tip rather than
// checking out — checkout instead opens this small popover (via double-click,
// right-click, or the row's own ⋮ button), so a misdirected single click
// (aiming for the visibility checkbox right next to it, or just brushing the
// row) can no longer switch branches with zero recourse. Only the popover's
// own "Switch" button actually calls checkout/checkoutRemote. `remote`
// mirrors DirtyCheckoutMenu's own local-vs-remote-ref shape: false calls
// plain `checkout` (an existing local branch row), true calls
// `checkoutRemote` (a remote row, which may still need to CREATE a local
// branch first).
export type CheckoutConfirm = { name: string; remote: boolean; x: number; y: number };

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

// ── ref folder tree (Git-Fork-style "/"-segmented hierarchy) ───────────────
//
// Branch names are conventionally path-like (`feature/some-work`,
// `release/1.0`, `fix/win/askpass`). Rendered as one flat list of full names, a
// few dozen of them read as undifferentiated noise: the shared prefix repeats on
// every row while the part that distinguishes them is what an ellipsis truncates
// away first. So each `/`-separated segment except the last becomes a
// collapsible FOLDER and a leaf row shows only its own last segment — the way
// Git Fork, Sourcetree and VS Code all group them.
//
// Deliberately produces a FLAT, pre-ordered row array rather than a nested
// structure: Svelte 5 can render a recursive tree via self-referencing
// snippets, but a flat list keeps the view a single ordinary `{#each}` (so
// every existing per-row concern — the visibility checkbox, `data-branch`
// hooks the legacy layer/vimnav already query, the context menu, the busy
// spinner — stays exactly where it was), and makes the whole grouping a pure
// function this file can unit-test directly with no DOM at all.
//
// A one-segment name (`main`) is a depth-0 leaf and never gets a folder, so a
// repo that doesn't use `/` at all renders byte-identically to before.
export type RefRow<T> =
  | { kind: "folder"; path: string; label: string; depth: number; count: number; collapsed: boolean }
  | { kind: "leaf"; path: string; label: string; depth: number; item: T };

/**
 * Which sidebar list a folder path belongs to. Folder open/closed state is
 * keyed by this (see `folderOpen`) so `feature/` under Local and `feature/`
 * under Remotes fold independently — they're different lists that happen to
 * share a naming convention, not one thing shown twice.
 */
export type RefSection = "local" | "remote" | "tag";

// Internal tree shape, collapsed into `RefRow[]` by the walk at the end of
// `buildRefRows`.
type TreeDir<T> = {
  dirs: Map<string, TreeDir<T>>;
  leaves: { label: string; path: string; item: T }[];
};

function emptyDir<T>(): TreeDir<T> {
  return { dirs: new Map(), leaves: [] };
}

// Row ordering WITHIN each folder level: every folder first (A-Z), then every
// plain branch (A-Z). Folders-before-leaves is what Git Fork, Sourcetree and
// VS Code's explorer all do, and it's what makes a deep tree scannable — the
// structure is all at the top of each level instead of interleaved with leaves.
//
// Compares ONE segment against another (`walk` splits before calling in), so
// `numeric: true` is what puts `2` before `10` under a shared `release/` — plain
// lexicographic orders "10" first, which is actively wrong for the version-like
// names this grouping exists to tidy up.
//
// `sensitivity: "base"` makes it case-insensitive: git ref names ARE
// case-sensitive, but a list where `Fix/` sorts miles away from `fix/` reads as
// broken to anyone scanning it alphabetically.
export function compareRefLabels(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Group `items` into a flat, render-ready row list by splitting each item's
 * name on "/".
 *
 * `getName` returns the name to group by. Callers are expected to pass the ref's
 * FULL name, which is what makes a remote's own name the outermost folder
 * (`origin` > `feature` > `some-work`) exactly as it reads on screen.
 *
 * `isCollapsed(path)` is asked per folder using the folder's own full path
 * (e.g. `feature/win`), so nested folders collapse independently.
 *
 * `forceExpand` renders every folder open regardless of `isCollapsed` — used
 * while a ref filter is active, so surviving matches can never be hidden
 * inside a folder the user collapsed earlier (the same thing VS Code's
 * explorer and Git Fork's own filter box do). Collapsed state is NOT cleared,
 * so it comes back intact once the filter is emptied.
 *
 * Rows are ordered per level by `compareRefLabels`: folders A-Z first, then
 * plain refs A-Z. The caller's incoming order is deliberately NOT preserved, so
 * the rendered order doesn't depend on how the backend enumerated refs.
 *
 * Empty-segment noise (`a//b`, a stray trailing "/") is dropped rather than
 * producing a blank folder row. Git rejects those ref names, so this is pure
 * defensiveness against a hand-written fixture, not a path a real repo reaches.
 */
export function buildRefRows<T>(
  items: T[],
  getName: (item: T) => string,
  isCollapsed: (path: string) => boolean,
  forceExpand = false,
): RefRow<T>[] {
  const root = emptyDir<T>();

  for (const item of items) {
    const segments = getName(item).split("/").filter((s) => s !== "");
    if (segments.length === 0) continue;
    const leafLabel = segments[segments.length - 1];
    let dir = root;
    for (const seg of segments.slice(0, -1)) {
      let next = dir.dirs.get(seg);
      if (!next) {
        next = emptyDir<T>();
        dir.dirs.set(seg, next);
      }
      dir = next;
    }
    dir.leaves.push({ label: leafLabel, path: getName(item), item });
  }

  // Total leaves at or below a folder — drives its count badge, so a collapsed
  // folder still tells you how much it's hiding.
  function countLeaves(dir: TreeDir<T>): number {
    let n = dir.leaves.length;
    for (const child of dir.dirs.values()) n += countLeaves(child);
    return n;
  }

  const rows: RefRow<T>[] = [];
  function walk(dir: TreeDir<T>, depth: number, prefix: string): void {
    // Folders first, A-Z …
    for (const seg of [...dir.dirs.keys()].sort(compareRefLabels)) {
      const child = dir.dirs.get(seg)!;
      const path = prefix ? `${prefix}/${seg}` : seg;
      const collapsed = !forceExpand && isCollapsed(path);
      rows.push({ kind: "folder", path, label: seg, depth, count: countLeaves(child), collapsed });
      // A collapsed folder contributes its own row (with its count) but none of
      // its descendants — that's the whole point of collapsing, and it also
      // means the view never renders rows it would just have to hide.
      if (!collapsed) walk(child, depth + 1, path);
    }
    // … then the plain branches at this level, A-Z.
    for (const leaf of [...dir.leaves].sort((a, b) => compareRefLabels(a.label, b.label))) {
      rows.push({ kind: "leaf", path: leaf.path, label: leaf.label, depth, item: leaf.item });
    }
  }
  walk(root, 0, "");
  return rows;
}

/**
 * The remote a remote-tracking ref belongs to (`origin/feature/x` -> `origin`),
 * or `null` for a name with no remote prefix at all.
 *
 * The tree itself doesn't need this — it groups remotes by their full name, so
 * the remote falls out as the outermost folder on its own. This is for the one
 * thing that is per-remote rather than per-folder: the lane colour every one of
 * a remote's branch dots shares.
 */
export function remoteHead(name: string): string | null {
  const slash = name.indexOf("/");
  return slash === -1 ? null : name.slice(0, slash);
}

/**
 * Every folder path in `items`, at every nesting level (`feature`,
 * `feature/win`, …) — what "collapse all" needs in order to fold the whole
 * tree in one click without first having to render it.
 */
export function refFolderPaths<T>(items: T[], getName: (item: T) => string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const segments = getName(item).split("/").filter((s) => s !== "");
    let prefix = "";
    for (const seg of segments.slice(0, -1)) {
      prefix = prefix ? `${prefix}/${seg}` : seg;
      if (!seen.has(prefix)) {
        seen.add(prefix);
        out.push(prefix);
      }
    }
  }
  return out;
}

class SidebarState {
  locals = $state<LocalBranch[]>([]);
  remotes = $state<SimpleRef[]>([]);
  tags = $state<SimpleRef[]>([]);
  submodules = $state<SubmoduleInfo[]>([]);
  head = $state<string | null>(null);
  // Branch-visibility filter for the commit graph (persisted per repo — see
  // repo_registry.rs's own VisibleBranches doc comment). `null` = no filter
  // for this KIND, show every branch of it (today's default); a non-null
  // array means "only these branch names" (an empty array legitimately
  // means "none of this kind"). The two are INDEPENDENT — filtering local
  // branches while leaving every remote fully visible (or vice versa) is a
  // normal, expected combination, not an edge case; toggleBranchVisible
  // below only ever touches the one kind it's called for.
  visibleLocal = $state<string[] | null>(null);
  visibleRemote = $state<string[] | null>(null);
  // "Auto" branch-visibility mode (persisted alongside visibleLocal/
  // visibleRemote — see repo_registry.rs's own VisibleBranches.auto doc
  // comment): when true, visibleLocal is periodically RECOMPUTED (current
  // branch + anything with unpushed or unmerged-into-default commits) and
  // overwritten by recomputeAutoVisibility, rather than manually curated —
  // manually toggling a checkbox turns it back off (see toggleBranchVisible).
  // Only ever curates LOCAL branches; visibleRemote stays untouched/null in
  // auto mode (remotes are read-only mirrors, not "my own" work to declutter).
  autoMode = $state(false);
  snapshots = $state<Snapshot[]>([]);
  filter = $state("");
  // EXPLICIT folder open/closed choices in the ref tree (see buildRefRows),
  // keyed "<section>:<folderPath>" — `local:feature`, `remote:feature`,
  // `tag:v1` — so the same folder name under Local, Remotes and Tags folds
  // independently rather than in lockstep.
  //
  // Only folders the user actually CLICKED appear here (`true` = opened by
  // hand). An absent key means "still at the default", and the default is
  // CLOSED — see `folderOpenByDefault`. Storing the exception rather than the
  // full state is what lets the default itself have a rule (the HEAD path,
  // below) without a click being indistinguishable from that rule.
  //
  // A plain object, not a Set/Map: `$state` tracks a reassigned object without
  // needing svelte/reactivity's wrappers, and it stays small (folder count, not
  // branch count).
  //
  // Scoped to ONE repo and never written to disk. This controller is a
  // singleton that every repo reuses, so the map is cleared whenever the open
  // repo changes (see `refreshRefs`) — without that, collapsing `origin` in one
  // repo would silently collapse it in the next one opened, since paths like
  // `remote:origin` are identical across repos. Not persisted either: collapse
  // state is cheap to re-establish by hand, while a tree restored into a shape
  // that doesn't match what you left is harder to make sense of than a default
  // that's always the same.
  folderOpen = $state<Record<string, boolean>>({});
  // The repo `folderOpen` currently describes, so a change of repo can clear it.
  private folderOpenRepo: string | null = null;

  /**
   * Whether a folder starts open with no user interaction at all.
   *
   * Closed by default — that's the point of the grouping, since a repo with a
   * dozen `feature/*` branches should open as a short list of folders rather
   * than the flat wall it replaced. Two exceptions, both for folders that are
   * containers rather than naming-convention buckets:
   *
   *   * A REMOTE's own node (a remote-section path with no "/" in it). It isn't
   *     a bucket the user invented, it's the thing the section is about, and the
   *     section's own disclosure already has to be opened first — so shutting
   *     the remotes as well would put two clicks between the user and any
   *     branch. Folders NESTED inside a remote get the normal closed default.
   *   * The folders leading to the CURRENT branch, in Local. The sidebar's "you
   *     are here" marker on HEAD is a headline orientation feature; hiding the
   *     current branch inside a folded folder on every launch would trade one
   *     kind of clutter for a worse kind of disorientation. Local only —
   *     remotes and tags have no "current" of their own.
   */
  folderOpenByDefault(section: RefSection, path: string): boolean {
    if (section === "remote") return !path.includes("/");
    return section === "local" && this.head !== null && this.head.startsWith(`${path}/`);
  }

  isFolderCollapsed(section: RefSection, path: string): boolean {
    const explicit = this.folderOpen[`${section}:${path}`];
    if (explicit !== undefined) return !explicit;
    return !this.folderOpenByDefault(section, path);
  }

  toggleFolder(section: RefSection, path: string): void {
    // Writes an explicit entry either way — after a click, this folder no
    // longer follows the default (so collapsing the HEAD folder sticks).
    const wasCollapsed = this.isFolderCollapsed(section, path);
    this.folderOpen = { ...this.folderOpen, [`${section}:${path}`]: wasCollapsed };
  }

  /**
   * Every folder path of one section, keyed exactly the way its rows key their
   * own collapse state — so "collapse all" and "is every folder folded?" can
   * never disagree with what a click on one folder does.
   *
   * Uniform across sections because all three render one tree over the ref's
   * FULL name. For remotes that means the remote itself is the outermost folder
   * (`origin`, then `origin/feature`), which is both how it looks on screen and
   * what keeps `feature/` under two different remotes from colliding.
   */
  folderPaths(section: RefSection): string[] {
    if (section === "local") return refFolderPaths(this.locals, (b) => b.name);
    if (section === "tag") return refFolderPaths(this.tags, (t) => t.name);
    return refFolderPaths(this.remotes, (r) => r.name);
  }

  /**
   * Fold/unfold every folder of one section at once. Mirrors the
   * "Hide all branches"/"Show all branches" pair already in the filter bar:
   * one click to get to a clean slate, one to get everything back.
   *
   * Writes an explicit entry for every folder in BOTH directions (rather than
   * clearing keys for the collapse case) so the result is exactly what was
   * asked for — clearing would hand folders back to `folderOpenByDefault`,
   * leaving the HEAD path open right after a "collapse all".
   *
   * The folder list comes from the section's CURRENT refs (`folderPaths`)
   * rather than from whatever happens to be rendered, so it reaches nested
   * folders too — including ones inside an already-collapsed folder that isn't
   * on screen at all.
   */
  setAllFoldersCollapsed(section: RefSection, collapsed: boolean): void {
    const next = { ...this.folderOpen };
    for (const path of this.folderPaths(section)) next[`${section}:${path}`] = !collapsed;
    this.folderOpen = next;
  }

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
  // "Push to…" popover — same "only one popover open at a time" invariant as
  // menu/tagMenu/submoduleMenu/mergeMenu above (see `openPushMenu`, and every
  // other open* method's own null-out of this one). pushBranchInput is the
  // popover's own text field value: "" means "same name as the local branch"
  // (see pushBranch's own doc comment), not yet typed into.
  pushMenu = $state<PushMenu | null>(null);
  pushBranchInput = $state("");
  // "Rename branch" popover — a second-level popover opened from the branch
  // menu, same one-at-a-time / (x,y)-reuse shape as pushMenu above. `renameInput`
  // is PRE-FILLED with the current name (a rename edits an existing name, unlike
  // push's empty "same name" default — see openRenameMenu).
  renameMenu = $state<{ name: string; x: number; y: number } | null>(null);
  renameInput = $state("");
  // Backlog #34's dirty-tree resolution chooser — same "only one popover open
  // at a time" invariant as menu/tagMenu/submoduleMenu/mergeMenu above (see
  // openDirtyCheckoutMenu, and every other open* method's own null-out of
  // this one).
  dirtyCheckoutMenu = $state<DirtyCheckoutMenu | null>(null);
  // The checkout-confirm popover — same "only one popover open at a time"
  // invariant as menu/tagMenu/submoduleMenu/mergeMenu/dirtyCheckoutMenu above
  // (see openCheckoutConfirm, and every other open* method's own null-out of
  // this one).
  checkoutConfirm = $state<CheckoutConfirm | null>(null);
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
  // Which branch/remote-ref name's "copy" button was last clicked — "" when
  // none (or the 900ms feedback window has already elapsed). Same shape as
  // copiedSnapshotSha above.
  copiedBranch = $state("");
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
    // Three independent reads, fired concurrently rather than one awaiting
    // another — none needs another's result, and a slow/failing one
    // shouldn't hold up the rest.
    await Promise.all([this.refreshRefs(repo), this.refreshSubmodules(repo), this.refreshVisibleBranches(repo)]);
    // Auto mode recomputes AFTER the barrier above, never inside it — it
    // needs refreshRefs's own fresh ahead/behind data (this.locals), which
    // refreshVisibleBranches (just loading the persisted `auto` flag) can't
    // guarantee has landed yet if run concurrently with it.
    if (this.autoMode) await this.recomputeAutoVisibility(repo);
  }

  private async refreshRefs(repo: string) {
    // Folder collapse state describes one repo's tree; the paths it keys on
    // (`remote:origin`, `local:feature`) recur in every repo, so carrying it
    // across a switch would silently apply one repo's folds to the next.
    if (this.folderOpenRepo !== repo) {
      this.folderOpen = {};
      this.folderOpenRepo = repo;
    }
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

  private async refreshVisibleBranches(repo: string) {
    try {
      const r = await commands.getVisibleBranches(repo);
      if (r.status !== "ok") {
        console.error("get_visible_branches", r.error);
        return;
      }
      this.autoMode = r.data.auto;
      this.visibleLocal = r.data.local;
      this.visibleRemote = r.data.remote;
    } catch (e) {
      console.error("get_visible_branches", e);
    }
  }

  // ── branch-visibility filter (repo-scoped, persisted) ───────────────────

  isBranchVisible(kind: "local" | "remote", name: string): boolean {
    const set = kind === "local" ? this.visibleLocal : this.visibleRemote;
    return set === null || set.includes(name);
  }

  // Click a ref row -> select its tip commit in the graph. The question is
  // "is this commit among the loaded rows?", never "is this branch ticked?":
  // the walk seeds from the visible branches and then follows their whole
  // ancestry, so an unticked branch that's already merged into a visible one
  // is in the graph and jumps just fine, with no reload.
  //
  // Three different situations all end in "no row for this oid" and only one
  // is a checkbox problem, so the message says which — a tag has no checkbox
  // to tick, and a branch that simply hasn't streamed in yet is already ticked.
  jumpToRef(section: RefSection, name: string, sha: string): void {
    if (!sha) {
      bridge.tama.warn(name + " has no commit to jump to.");
      return;
    }
    if (bridge.goToOid(sha)) return;
    // graphStreamComplete is only ever flipped true from Tauri-only paths:
    // onGraphBatch's `done` handling (wired up solely inside an IN_TAURI
    // branch), and restoreGraphFromCache — which only sets it when it hits a
    // cache entry, and an entry can only exist if some earlier onGraphBatch
    // `done` already set it true. In plain-browser design mode neither path
    // ever fires/hits, so graphStreamComplete stays permanently false and
    // this branch would otherwise always win.
    if (IN_TAURI && !bridge.graphStreamComplete) {
      bridge.tama.warn("Still loading the graph — try " + name + " again in a moment.");
      return;
    }
    if ((section === "local" || section === "remote") && !this.isBranchVisible(section, name)) {
      bridge.tama.warn(name + " isn't shown in the graph — tick its checkbox to load it.");
      return;
    }
    bridge.tama.warn(name + " isn't in the loaded graph — no branch currently shown reaches its commit.");
  }

  get isFiltering(): boolean {
    return this.visibleLocal !== null || this.visibleRemote !== null;
  }

  async toggleBranchVisible(repo: string, kind: "local" | "remote", name: string): Promise<void> {
    // A manual toggle is an explicit override — exits auto mode first (so
    // the very next refresh doesn't silently recompute over the user's own
    // click), same "grabbing the wheel turns off autopilot" reasoning
    // toggleAutoMode's own doc comment describes.
    this.autoMode = false;
    // Only ever touches the ONE kind being toggled — local/remote filters
    // are independent (see visibleLocal's own doc comment), so toggling a
    // local branch must never materialize (and thus start filtering) the
    // remote set, and vice versa. Lazily enters filtered mode for THIS kind
    // on its own first uncheck: seeds from everything of that kind
    // currently listed (not empty) minus the one being hidden — otherwise
    // the very first toggle would instantly hide every other branch of that
    // kind too, which is the opposite of "hide just this one".
    if (kind === "local") {
      const local = this.visibleLocal ?? this.locals.map((b) => b.name);
      const idx = local.indexOf(name);
      if (idx >= 0) local.splice(idx, 1);
      else local.push(name);
      this.visibleLocal = local;
    } else {
      const remote = this.visibleRemote ?? this.remotes.map((r) => r.name);
      const idx = remote.indexOf(name);
      if (idx >= 0) remote.splice(idx, 1);
      else remote.push(name);
      this.visibleRemote = remote;
    }
    await this.persistVisibleBranches(repo);
  }

  async showAllBranches(repo: string): Promise<void> {
    this.autoMode = false;
    this.visibleLocal = null;
    this.visibleRemote = null;
    await this.persistVisibleBranches(repo);
  }

  // Mirrors showAllBranches — the other direction of the same bulk action,
  // for quickly clearing a cluttered graph down to just the current branch
  // (always shown regardless of the filter — see push_head()'s own
  // guarantee, and the current-branch checkbox's own `disabled` in
  // Sidebar.svelte) before hand-picking a few more. `[]` (not `null`) for
  // both: `null` means "no filter, show everything" (isBranchVisible's own
  // doc comment) — an empty array is the one representation that actually
  // means "none of this kind".
  async hideAllBranches(repo: string): Promise<void> {
    this.autoMode = false;
    this.visibleLocal = [];
    this.visibleRemote = [];
    await this.persistVisibleBranches(repo);
  }

  // Tools-menu-adjacent entry point (the sidebar's own "Auto" pill) — turns
  // auto mode on (computing+persisting a filter immediately, not waiting for
  // the next refresh) or off (same full reset as showAllBranches, since
  // there's no manually-curated filter to fall back to once auto mode's own
  // computed one is discarded). Demo mode goes through the SAME path as
  // real mode (recomputeAutoVisibility's own doc comment covers how it
  // degrades gracefully without a backend) — a design-mode-only early
  // return here used to leave the filter untouched while still flipping the
  // "⚡ Auto" pill on, which looked exactly like "Auto shows everything".
  async toggleAutoMode(repo: string): Promise<void> {
    this.autoMode = !this.autoMode;
    if (this.autoMode) await this.recomputeAutoVisibility(repo);
    else await this.showAllBranches(repo);
  }

  // Current branch (always kept, same guarantee push_head() already gives
  // every OTHER filter path) + anything with unpushed commits (ahead of its
  // own upstream) + the most recently active of whatever's left that isn't
  // yet merged into the repo's resolved default branch (branch_merge_status),
  // ranked and capped rather than a plain age boolean — see
  // RECENCY_HALF_LIFE_DAYS/MAX_AUTO_CANDIDATES's own doc comment. Only ever
  // writes visibleLocal — see autoMode's own doc comment for why remotes are
  // left alone.
  //
  // "No upstream configured" is NOT by itself treated as "keep" once real
  // merge data is available — a branch with no upstream can still be fully
  // merged into the default branch (a local-only topic branch, or one whose
  // remote counterpart was deleted after a squash-merge, both very common),
  // and BUG: an earlier version OR'd `b.upstream === null` in unconditionally,
  // so every such branch stayed visible forever regardless of merge status —
  // in a repo where most local branches lack upstream tracking, that made
  // Auto mode look like it wasn't filtering anything at all. "No upstream" is
  // only used as the fallback signal for "possibly unpushed" when merge
  // status genuinely couldn't be determined (mergedInto === null — design
  // mode, or the backend call itself failed) — see the `mergedInto !== null
  // ? ... : ...` branch below, not an extra OR'd-in clause.
  //
  // Design mode has no backend to ask branch_merge_status of, so `mergedInto`
  // stays `null` there rather than an empty Set: the two must NOT collapse
  // into the same case — an empty Set means "asked, nothing came back
  // merged" (every branch legitimately fails the merged check, by design),
  // while `null` means "never asked" and the merged clause must fall back to
  // the upstream heuristic entirely rather than defaulting to "unmerged" for
  // every branch. Getting that backwards is exactly how demo mode used to
  // show every branch the instant Auto was toggled on.
  async recomputeAutoVisibility(repo: string): Promise<void> {
    let mergedInto: Set<string> | null = null;
    if (IN_TAURI) {
      // Only the real backend call needs a real repo path — design mode's
      // filter below is computed entirely from already-loaded `this.locals`,
      // same as `bridge.CUR_REPO` staying null throughout a design-mode
      // session that never "opens" a real repo at all.
      if (!repo) return;
      mergedInto = new Set<string>();
      try {
        const merge = await commands.branchMergeStatus(repo);
        if (merge.status === "ok") mergedInto = new Set(merge.data.merged);
        else console.error("branch_merge_status", merge.error);
      } catch (e) {
        console.error("branch_merge_status", e);
      }
    }
    // Two tiers (see RECENCY_HALF_LIFE_DAYS/MAX_AUTO_CANDIDATES's own doc
    // comment for why): `always` — the current branch and anything with
    // unpushed commits — is kept unconditionally, no cap, exactly the same
    // guarantee the old boolean filter gave those two cases. Everything else
    // that qualifies as "not yet merged" (same mergedInto/upstream-fallback
    // logic as before) becomes a scored `candidate`, ranked by a smooth
    // recency decay instead of the old hard STALE_DAYS boolean, and only the
    // top MAX_AUTO_CANDIDATES of those survive — this is what actually bounds
    // how many "still technically unmerged" branches Auto can show at once,
    // which the old filter never did at all.
    const now = Date.now() / 1000;
    const always: string[] = [];
    const candidates: { name: string; recency: number }[] = [];
    for (const b of this.locals) {
      if (b.name === this.head || (b.ahead ?? 0) > 0) {
        always.push(b.name);
        continue;
      }
      const isUnmergedCandidate = mergedInto !== null ? !mergedInto.has(b.name) : b.upstream === null;
      if (!isUnmergedCandidate) continue;
      const ageDays = Math.max(0, (now - b.lastCommitTime) / 86400);
      const recency = Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
      if (recency < MIN_RECENCY) continue;
      candidates.push({ name: b.name, recency });
    }
    candidates.sort((a, b) => b.recency - a.recency);
    const nextLocal = [...always, ...candidates.slice(0, MAX_AUTO_CANDIDATES).map((c) => c.name)];

    // ADVERSARIALLY-FOUND FIX: persistVisibleBranches always reloads the
    // graph (bridge.reloadGraph), and reloadGraph's own tail always calls
    // sidebarCtrl.refresh() again — which, in auto mode, calls straight back
    // into this method. Recomputing to the EXACT SAME set (the overwhelming
    // common case: nothing in the repo actually changed between one refresh
    // and the echo refresh reloadGraph itself triggers) used to still
    // unconditionally persist+reload anyway, so refresh -> recompute ->
    // persist -> reload -> refresh never terminated. Under the old blocking
    // load_graph this just looked like "auto mode is a bit slow" (each spin
    // paid for one whole synchronous walk); once load_graph started
    // returning almost immediately (see commands.rs's streaming rewrite),
    // the SAME loop span fast enough to pin the generation counter climbing
    // forever with the graph never able to render a single batch — a repo
    // with auto mode on could never finish loading at all. Comparing against
    // the PREVIOUS set and bailing out when nothing actually changed is what
    // breaks the cycle: the echo call computes the identical set and stops
    // here instead of persisting/reloading again.
    const prevLocal = this.visibleLocal;
    const sameLocal = prevLocal !== null && prevLocal.length === nextLocal.length && nextLocal.every((n) => prevLocal.includes(n));
    const sameRemote = this.visibleRemote === null; // this method always wants remote=null
    if (sameLocal && sameRemote) return;

    this.visibleLocal = nextLocal;
    this.visibleRemote = null;
    await this.persistVisibleBranches(repo);
  }

  private async persistVisibleBranches(repo: string): Promise<void> {
    if (!IN_TAURI || !repo) return; // design-mode: local state only, nothing to persist/reload
    let persisted = false;
    try {
      const res = await commands.setVisibleBranches(repo, this.autoMode, this.visibleLocal, this.visibleRemote);
      if (res.status === "ok") persisted = true;
      else console.error("set_visible_branches", res.error);
    } catch (e) {
      console.error("set_visible_branches", e);
    }
    if (!persisted) {
      // Nothing was stored, so the graph already matches the filter the backend
      // would walk with — reloading would spend a whole re-walk arriving back at
      // the same picture. Say so instead, and put the checkboxes back on the
      // persisted truth so the sidebar can't show a filter that isn't there.
      bridge.tama.warn("Couldn't save which branches to show.");
      await this.refreshVisibleBranches(repo);
      return;
    }
    // forceFull is load-bearing: which branches are visible decides which
    // commits the walk seeds from, so this ADDS OR REMOVES ROWS. reloadGraph's
    // fast path only remaps ref chips over rows that are already loaded, so it
    // has no way to express that; without forceFull the filter is persisted and
    // the graph silently keeps every commit.
    await bridge.reloadGraph(true, true);
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
        ICON_BACKUP +
        " I back up " +
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
        ICON_BACKUP +
        " If " +
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
    copyToClipboard(sha);
    this.copiedSnapshotSha = sha;
    setTimeout(() => {
      if (this.copiedSnapshotSha === sha) this.copiedSnapshotSha = "";
    }, 900);
  }

  // Same click-to-copy + brief "copied" feedback shape as copySnapshotSha
  // above (and Detail.svelte's own commit-hash copy) — a dedicated hover-
  // revealed button next to .rname, not the row's own click (which jumps the
  // graph to this ref's tip; stealing that gesture for copy would
  // shrink/replace a much more frequently used action).
  copyBranchName(name: string) {
    copyToClipboard(name);
    this.copiedBranch = name;
    setTimeout(() => {
      if (this.copiedBranch === name) this.copiedBranch = "";
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
    this.checkoutConfirm = null;
    this.pushMenu = null;
    this.hasRepo = false;
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
        ICON_WARNING +
        " This is NOT recoverable, and it is NOT limited to the " +
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
        // While a branch-visibility filter is active, a just-created branch
        // defaults to VISIBLE — otherwise a decluttered view would make a
        // freshly created branch mysteriously invisible, which reads as a
        // bug, not a feature. Persisted directly (not via
        // persistVisibleBranches, which also reloads the graph) so the
        // reloadGraph(true) just below is the only reload, picking up the
        // updated filter.
        if (this.visibleLocal !== null && !this.visibleLocal.includes(name)) {
          this.visibleLocal = [...this.visibleLocal, name];
          try {
            await commands.setVisibleBranches(bridge.CUR_REPO as unknown as string, this.autoMode, this.visibleLocal, this.visibleRemote);
          } catch (e) {
            console.error("set_visible_branches", e);
          }
        }
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
      note: ICON_BACKUP + " I pin the branch tip before deleting; ⌘Z restores your CURRENT branch position (not the deleted branch).",
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

  resetToUpstream(name: string, upstream: string) {
    bridge.tama.set("danger");
    bridge.tama.say("Resetting " + name + " to " + upstream + " — type the branch name to arm it. I pin its tip first.", 6000);
    bridge.armDanger({
      title: "Reset " + name + " to " + upstream,
      steps: false,
      desc: "This hard-resets the branch to match its upstream — any local commits or uncommitted changes on it are discarded. Its tip is pinned to a backup first, so the commits stay recoverable.",
      lose:
        "<h5>What happens</h5><ul><li>Moves local branch <code>" +
        esc(name) +
        "</code> to match <code>" +
        esc(upstream) +
        "</code></li><li>Discards any local-only commits" +
        (name === this.head ? " AND uncommitted working-tree changes" : "") +
        " on <code>" +
        esc(name) +
        "</code></li></ul>",
      note:
        ICON_BACKUP +
        " I pin " +
        name +
        "'s current tip before resetting; ⌘Z restores it" +
        (name === this.head ? "" : " (checking " + name + " back out first, since it may no longer be the current branch)") +
        ".",
      name,
      confirmLabel: "Reset branch",
      onConfirm: async () => {
        await this.doResetToUpstream(name, upstream);
      },
    });
  }

  private async doResetToUpstream(name: string, upstream: string) {
    if (!IN_TAURI) {
      bridge.tama.set("celebrate");
      bridge.tama.say("Reset " + name + " to " + upstream + " (demo).");
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.busyTarget = name;
    bridge.tama.set("thinking");
    bridge.tama.say("Resetting " + name + " to " + upstream + "…");
    try {
      const res = await commands.resetBranchToUpstream(bridge.CUR_REPO as unknown as string, name);
      if (res && res.ok) {
        await bridge.reloadGraph(true);
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Reset " + name + " to " + upstream + ".", 4200);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't reset " + name + ".");
      }
    } catch (e) {
      bridge.tama.warn("Reset failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  openMenu(name: string, isCurrent: boolean, anchor: HTMLElement, upstream: string | null = null) {
    const r = anchor.getBoundingClientRect();
    this.openMenuAt(name, isCurrent, upstream, Math.min(r.left, window.innerWidth - 168), r.bottom + 4);
  }
  // Coordinate-based entry point — same menu but positioned at (x,y) instead of
  // under an anchor element. Lets the graph's right-click-a-branch-label open
  // this exact branch-management popover at the cursor (see legacy/main.ts's
  // canvas "contextmenu"), reusing every action rather than a parallel menu.
  openMenuAt(name: string, isCurrent: boolean, upstream: string | null, x: number, y: number) {
    this.tagMenu = null; // only one popover open at a time
    this.submoduleMenu = null;
    this.mergeMenu = null;
    this.dirtyCheckoutMenu = null;
    this.checkoutConfirm = null;
    this.pushMenu = null;
    this.renameMenu = null;
    this.menu = { name, isCurrent, upstream, x: Math.min(x, window.innerWidth - 168), y };
  }

  closeMenu() {
    this.menu = null;
  }

  // Push-to-a-different-remote-branch-name popover — a SECOND-level popover
  // opened from inside the branch popover's own "Push to…" button, same
  // "reuse that button's already-computed (x, y)" shape as openMergeMenu
  // just below (the branch popover it lives in is about to be closed in the
  // same click handler — see Sidebar.svelte). pushBranchInput starts empty
  // (meaning "same name as the local branch" — see pushBranch's own doc
  // comment), not pre-filled with `name`, so the common case (same name) is
  // just leaving the field untouched, not clearing a pre-filled value first.
  openPushMenu(name: string, x: number, y: number) {
    this.menu = null; // only one popover open at a time
    this.tagMenu = null;
    this.submoduleMenu = null;
    this.mergeMenu = null;
    this.dirtyCheckoutMenu = null;
    this.checkoutConfirm = null;
    this.pushBranchInput = "";
    this.pushMenu = { name, x: Math.min(x, window.innerWidth - 220), y };
  }

  // Cancel — no push attempted. Same name as cancelNewBranch/cancelNewTag,
  // whose "outside-click / Escape closes the form, no request sent" shape
  // this mirrors exactly (see onWindowPointerdown/onPushBranchKeydown in
  // Sidebar.svelte).
  cancelPushMenu() {
    this.pushMenu = null;
    this.pushBranchInput = "";
  }

  // Pushes `name` — NOT necessarily the checked-out branch, and never
  // switches to it — optionally under a different name on the remote side
  // (`remoteBranch`; the plain one-click "Push" button passes `null`, i.e.
  // same name). Mirrors pushTag's own shape (busy/busyTarget, Tama
  // messaging), not plain push() in legacy/main.ts — that one always targets
  // whatever branch is currently checked out and has no notion of a
  // differently-named remote branch. Returns whether it succeeded so
  // confirmPushMenu (below) can decide whether to close its own popover —
  // shared by both the simple one-click "Push" button (Sidebar.svelte calls
  // this directly) and the "Push to…" form (via confirmPushMenu).
  async pushBranch(name: string, remoteBranch: string | null): Promise<boolean> {
    const target = remoteBranch && remoteBranch !== name ? `${name} to ${remoteBranch}` : name;
    if (!IN_TAURI) {
      bridge.tama.set("celebrate");
      bridge.tama.say("Pushed " + target + " (demo).");
      return true;
    }
    if (this.busy) return false;
    this.busy = true;
    this.busyTarget = name;
    bridge.tama.set("thinking");
    bridge.tama.say("Pushing " + target + "…");
    try {
      const res = await commands.pushBranch(bridge.CUR_REPO as unknown as string, name, null, remoteBranch);
      if (res && res.ok) {
        // Push moves the remote-tracking ref (origin/<branch>) forward and
        // resets ahead/behind, but never touches local HEAD — so neither the
        // status poll (keyed on local branch/head/dirty) nor an unchanged local
        // graph updates on its own. Refresh so the moved origin/* label and the
        // branch pill's ↑/↓ counts update live (reloadGraph's tail refreshes the
        // sidebar too).
        await bridge.reloadGraph(true);
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Pushed " + target + ".", 3200);
        return true;
      }
      bridge.tama.warn((res && res.message) || "Couldn't push " + target + ".");
      return false;
    } catch (e) {
      bridge.tama.warn("Push failed — " + e);
      console.error(e);
      return false;
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
  }

  // "Push to…" form's own submit — "" in the input means "same name as the
  // local branch" (pushBranch's own null-means-same-name convention), not an
  // error, unlike confirmNewBranch's empty-means-cancel. Keeps the popover
  // OPEN (disabled/spinnered — see Sidebar.svelte) on failure so a rejected
  // push (e.g. non-fast-forward) can be retried without re-typing, same
  // retry-friendly shape confirmNewBranch/confirmNewTag already use; only
  // closes on success.
  async confirmPushMenu() {
    if (!this.pushMenu || this.busy) return;
    const name = this.pushMenu.name;
    const remoteBranch = this.pushBranchInput.trim() || null;
    const ok = await this.pushBranch(name, remoteBranch);
    if (ok) {
      this.pushMenu = null;
      this.pushBranchInput = "";
    }
  }

  // "Rename…" from the branch popover — a SECOND-level popover with the current
  // name PRE-FILLED to edit, same (x,y)-reuse + Enter-to-confirm/Esc-to-cancel
  // shape as openPushMenu. Pre-filled (unlike push's empty "same name" default)
  // because a rename is an edit of the existing name, not a fresh entry.
  openRenameMenu(name: string, x: number, y: number) {
    this.menu = null; // only one popover open at a time
    this.tagMenu = null;
    this.submoduleMenu = null;
    this.mergeMenu = null;
    this.pushMenu = null;
    this.dirtyCheckoutMenu = null;
    this.checkoutConfirm = null;
    this.renameInput = name;
    this.renameMenu = { name, x: Math.min(x, window.innerWidth - 240), y };
  }

  cancelRenameMenu() {
    this.renameMenu = null;
    this.renameInput = "";
  }

  // Rename `from` -> the typed name (`git branch -m`). Empty or unchanged means
  // cancel, no request. Keeps the popover OPEN on failure (retry-friendly, same
  // as confirmPushMenu); only closes on success. Carries the branch's entry in
  // the visible-branch filter across the rename so a renamed branch doesn't
  // vanish from a decluttered view (persisted directly; the reloadGraph below is
  // the one reload — same discipline as confirmNewBranch).
  async confirmRenameMenu() {
    if (!this.renameMenu || this.busy) return;
    const from = this.renameMenu.name;
    const to = this.renameInput.trim();
    if (!to || to === from) {
      this.cancelRenameMenu();
      return;
    }
    if (!IN_TAURI) {
      this.renameMenu = null;
      this.renameInput = "";
      bridge.tama.set("hint");
      bridge.tama.say("Renamed " + from + " → " + to + " (demo).");
      return;
    }
    this.busy = true;
    this.busyTarget = from;
    bridge.tama.set("thinking");
    bridge.tama.say("Renaming " + from + " → " + to + "…");
    try {
      const res = await commands.renameBranch(bridge.CUR_REPO as unknown as string, from, to);
      if (res && res.ok) {
        // Keep a renamed branch in the visible set under its new name, and
        // persist that directly for the same reason confirmNewBranch does (see
        // its own comment): the reloadGraph(true) below is the only reload. It
        // stays on the fast path deliberately — a rename moves no commit, so no
        // row appears or disappears and there is nothing for a full re-walk to
        // find, unlike a visibility change.
        if (this.visibleLocal !== null && this.visibleLocal.includes(from)) {
          this.visibleLocal = this.visibleLocal.map((b) => (b === from ? to : b));
          try {
            await commands.setVisibleBranches(bridge.CUR_REPO as unknown as string, this.autoMode, this.visibleLocal, this.visibleRemote);
          } catch (e) {
            console.error("set_visible_branches", e);
          }
        }
        this.renameMenu = null;
        this.renameInput = "";
        await bridge.reloadGraph(true);
        bridge.tama.set("celebrate");
        bridge.tama.say(res.message || "Renamed to " + to + ".", 3200);
      } else {
        bridge.tama.warn((res && res.message) || "Couldn't rename " + from + ".");
      }
    } catch (e) {
      bridge.tama.warn("Rename failed — " + e);
      console.error(e);
    } finally {
      this.busy = false;
      this.busyTarget = null;
    }
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
    this.checkoutConfirm = null;
    this.pushMenu = null;
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
    this.checkoutConfirm = null;
    this.pushMenu = null;
    this.dirtyCheckoutMenu = { name, startPoint, files, x: Math.min(x, window.innerWidth - 260), y };
  }

  closeDirtyCheckoutMenu() {
    this.dirtyCheckoutMenu = null;
  }

  // Opened by a branch row's double-click, right-click, or its own ⋮ button
  // — see CheckoutConfirm's own doc comment for why checkout doesn't fire
  // directly from a single click/Enter on the row. Reuses whatever (x, y)
  // the row's own bounding rect already produced, same as
  // openMergeMenu/openDirtyCheckoutMenu above.
  openCheckoutConfirm(name: string, remote: boolean, x: number, y: number) {
    this.menu = null; // only one popover open at a time
    this.tagMenu = null;
    this.submoduleMenu = null;
    this.mergeMenu = null;
    this.dirtyCheckoutMenu = null;
    this.pushMenu = null;
    this.checkoutConfirm = { name, remote, x: Math.min(x, window.innerWidth - 200), y };
  }

  closeCheckoutConfirm() {
    this.checkoutConfirm = null;
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
      note: ICON_BACKUP + " I pin the tag's target before deleting; this is NOT restorable via the global Undo (⌘Z) — that only rewinds branches, never tags.",
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
    this.checkoutConfirm = null;
    this.pushMenu = null;
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
    this.checkoutConfirm = null;
    this.pushMenu = null;
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
