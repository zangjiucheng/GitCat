//! Cherry-pick + conflict resolver (model after examples/pickcheck.rs).
//!
//! Drives a real conflicting cherry-pick end to end: cherry_pick -> conflict_
//! status (asserting real ours/base/theirs text) -> resolve_conflict_file
//! ("theirs") -> cherry_pick_continue (asserting PickResult.state == "clean")
//! — and, separately, a cherry_pick -> cherry_pick_abort flow that fully
//! restores HEAD and RepositoryState::Clean.

mod common;

use common::TempRepo;
use git2::RepositoryState;
use gitcat_lib::conflict::{conflict_status, resolve_conflict_file};
use gitcat_lib::git_pick::{cherry_pick, cherry_pick_abort, cherry_pick_continue};

/// Builds a repo where cherry-picking `feature`'s tip onto `main` conflicts:
/// both branches edit the same line of the same file after a common base.
/// Returns (repo, main_head_sha, feature_tip_sha).
fn build_conflicting_repo(tag: &str) -> (TempRepo, String, String) {
    let repo = TempRepo::init(tag);
    let _base = repo.commit("shared.txt", "base line\n", "base");
    repo.must(&["branch", "feature"]);

    let main_head = repo.commit("shared.txt", "main line\n", "edit on main");

    repo.must(&["checkout", "-q", "feature"]);
    let feature_tip = repo.commit("shared.txt", "feature line\n", "edit on feature");

    repo.must(&["checkout", "-q", "main"]);
    assert_eq!(repo.rev("HEAD").as_deref(), Some(main_head.as_str()));

    (repo, main_head, feature_tip)
}

#[test]
fn cherry_pick_conflict_resolve_theirs_then_continue() {
    let (repo, _main_head, feature_tip) = build_conflicting_repo("pick_resolve");
    let path = repo.path();

    let picked = tauri::async_runtime::block_on(cherry_pick(path.clone(), feature_tip.clone(), Some(true)));
    assert_eq!(picked.state, "conflict", "expected a conflict, got: {}", picked.message);
    assert!(!picked.ok);
    assert_eq!(picked.conflicted_files, vec!["shared.txt".to_string()]);
    assert!(picked.backup_ref.is_some(), "cherry_pick should snapshot before mutating");

    let status = tauri::async_runtime::block_on(conflict_status(path.clone())).expect("conflict_status failed");
    assert!(status.in_progress);
    assert_eq!(status.op, "cherry-pick");
    assert_eq!(status.files.len(), 1);
    let f = &status.files[0];
    assert_eq!(f.path, "shared.txt");
    assert_eq!(f.base, "base line");
    assert_eq!(f.ours, "main line");
    assert_eq!(f.theirs, "feature line");

    let resolved = tauri::async_runtime::block_on(resolve_conflict_file(path.clone(), "shared.txt".into(), "theirs".into()));
    assert!(resolved.ok, "resolve_conflict_file failed: {}", resolved.message);
    assert_eq!(resolved.remaining, 0);

    let cont = tauri::async_runtime::block_on(cherry_pick_continue(path.clone()));
    assert!(cont.ok, "cherry_pick_continue failed: {}", cont.message);
    assert_eq!(cont.state, "clean");

    // Working tree now carries the "theirs" content, and the repo is no
    // longer mid-pick.
    assert_eq!(repo.read("shared.txt"), "feature line\n");
    let after = tauri::async_runtime::block_on(conflict_status(path.clone())).expect("conflict_status failed");
    assert!(!after.in_progress);
    assert_eq!(after.files.len(), 0);
    assert_eq!(repo.open().state(), RepositoryState::Clean);
}

// Resolving the conflict back to "ours" (HEAD's own side — the in-app hunk
// editor's pre-filled default, and what "Take ours" produces) leaves the pick
// with NO net change: `git cherry-pick --continue` reports it "now empty".
// classify must NOT silently auto-abort + report a benign "already applied"
// here (that reads as "nothing happened, no commit" to the user). It must keep
// the pick in progress and report state:"conflict" with an empty file list and
// an explanatory message, so the resolver's stuck banner surfaces WHY nothing
// was committed and Abort stays reachable.
#[test]
fn cherry_pick_resolve_to_ours_is_empty_and_stays_in_progress() {
    let (repo, main_head, feature_tip) = build_conflicting_repo("pick_empty_ours");
    let path = repo.path();

    let picked = tauri::async_runtime::block_on(cherry_pick(path.clone(), feature_tip, Some(true)));
    assert_eq!(picked.state, "conflict", "expected a conflict, got: {}", picked.message);

    let resolved = tauri::async_runtime::block_on(resolve_conflict_file(path.clone(), "shared.txt".into(), "ours".into()));
    assert!(resolved.ok, "resolve_conflict_file failed: {}", resolved.message);
    assert_eq!(resolved.remaining, 0);

    let cont = tauri::async_runtime::block_on(cherry_pick_continue(path.clone()));
    assert_eq!(cont.state, "conflict", "empty-after-resolution must not be 'clean'/'empty', got: {}", cont.message);
    assert!(!cont.ok);
    assert!(cont.conflicted_files.is_empty(), "no per-file conflict remains — it routes to the stuck banner");
    assert!(
        cont.message.to_lowercase().contains("nothing to commit") || cont.message.to_lowercase().contains("no changes"),
        "message should explain the empty result, got: {}",
        cont.message
    );

    // Still mid-pick, HEAD unmoved — the user can Abort (or redo taking theirs).
    let status = tauri::async_runtime::block_on(conflict_status(path.clone())).expect("conflict_status failed");
    assert!(status.in_progress, "must stay in progress, not auto-abort");
    assert_eq!(status.files.len(), 0);
    assert_eq!(repo.rev("HEAD").as_deref(), Some(main_head.as_str()), "HEAD must not have moved");

    // Abort cleans up back to the pre-pick state.
    let aborted = tauri::async_runtime::block_on(cherry_pick_abort(path.clone()));
    assert!(aborted.ok, "cherry_pick_abort failed: {}", aborted.message);
    assert_eq!(repo.open().state(), RepositoryState::Clean);
    assert_eq!(repo.rev("HEAD").as_deref(), Some(main_head.as_str()));
}

#[test]
fn cherry_pick_abort_restores_head() {
    let (repo, main_head, feature_tip) = build_conflicting_repo("pick_abort");
    let path = repo.path();

    let picked = tauri::async_runtime::block_on(cherry_pick(path.clone(), feature_tip, Some(true)));
    assert_eq!(picked.state, "conflict", "expected a conflict, got: {}", picked.message);
    assert_eq!(repo.open().state(), RepositoryState::CherryPick);

    let aborted = tauri::async_runtime::block_on(cherry_pick_abort(path.clone()));
    assert!(aborted.ok, "cherry_pick_abort failed: {}", aborted.message);
    assert_eq!(aborted.state, "clean");

    // Full restoration: HEAD sha, repo state, and working tree content.
    assert_eq!(repo.rev("HEAD").as_deref(), Some(main_head.as_str()));
    assert_eq!(repo.open().state(), RepositoryState::Clean);
    assert_eq!(repo.read("shared.txt"), "main line\n");
    assert!(repo.is_clean());

    // Abort is idempotent when nothing is in progress.
    let again = tauri::async_runtime::block_on(cherry_pick_abort(path));
    assert!(again.ok);
    assert_eq!(again.state, "clean");
}

#[test]
fn cherry_pick_blocked_by_dirty_tree_reports_blocked_by_local_changes() {
    let repo = TempRepo::init("pick_dirty_block");
    let _c0 = repo.commit("a.txt", "base\n", "c0");
    repo.must(&["branch", "feature"]);
    repo.must(&["checkout", "-q", "feature"]);
    let feature_tip = repo.commit("a.txt", "feature-a\n", "feature edits a.txt");
    repo.must(&["checkout", "-q", "main"]);
    let path = repo.path();

    // Dirty a.txt (unstaged) in a way that collides with what the pick would touch.
    std::fs::write(repo.dir.join("a.txt"), "dirty-a\n").unwrap();
    assert!(!repo.is_clean());

    let picked = tauri::async_runtime::block_on(cherry_pick(path.clone(), feature_tip, Some(true)));
    assert!(!picked.ok);
    assert_eq!(picked.state, "error", "expected a dirty-tree refusal, got state {:?}: {}", picked.state, picked.message);
    assert!(picked.blocked_by_local_changes, "expected blocked_by_local_changes=true: {}", picked.message);
    assert!(picked.backup_ref.is_some(), "cherry_pick snapshots before running git, even on a refusal it caused");
    assert!(picked.conflicted_files.is_empty());
    // Refused atomically: nothing was actually picked, and the dirty file is untouched.
    assert_eq!(repo.read("a.txt"), "dirty-a\n");
    assert_eq!(repo.open().state(), RepositoryState::Clean);
}

#[test]
fn cherry_pick_bad_revision_is_not_reported_as_blocked_by_local_changes() {
    let repo = TempRepo::init("pick_bad_rev");
    let _c0 = repo.commit("a.txt", "base\n", "c0");
    let path = repo.path();

    let picked = tauri::async_runtime::block_on(cherry_pick(path, "not-a-real-sha".into(), Some(true)));
    assert!(!picked.ok);
    assert_eq!(picked.state, "error");
    assert!(!picked.blocked_by_local_changes, "a bad revision must not be misclassified as a dirty-tree block: {}", picked.message);
}
