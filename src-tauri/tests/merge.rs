//! Merge + conflict resolver (model after tests/cherry_pick.rs).
//!
//! Drives a real conflicting merge end to end: merge_start -> conflict_status
//! (asserting real ours/base/theirs text AND `op == "merge"`) -> resolve_
//! conflict_file ("theirs") -> merge_continue (asserting MergeResult.state ==
//! "clean") — and, separately, a merge_start -> merge_abort flow that fully
//! restores HEAD and RepositoryState::Clean (with full idempotency). Also
//! covers a clean fast-forward merge and the "already up to date" no-op.

mod common;

use common::TempRepo;
use git2::RepositoryState;
use gitcat_lib::conflict::{conflict_status, resolve_conflict_file};
use gitcat_lib::git_merge::{merge_abort, merge_continue, merge_start};

/// Builds a repo where merging `feature` into `main` conflicts: both branches
/// edit the same line of the same file after a common base.
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
fn merge_conflict_resolve_theirs_then_continue() {
    let (repo, _main_head, feature_tip) = build_conflicting_repo("merge_resolve");
    let path = repo.path();

    let merged = merge_start(path.clone(), feature_tip.clone());
    assert_eq!(merged.state, "conflict", "expected a conflict, got: {}", merged.message);
    assert!(!merged.ok);
    assert_eq!(merged.conflicted_files, vec!["shared.txt".to_string()]);
    assert!(merged.backup_ref.is_some(), "merge_start should snapshot before mutating");
    assert_eq!(repo.open().state(), RepositoryState::Merge);

    let status = conflict_status(path.clone()).expect("conflict_status failed");
    assert!(status.in_progress);
    assert_eq!(status.op, "merge");
    assert_eq!(status.files.len(), 1);
    let f = &status.files[0];
    assert_eq!(f.path, "shared.txt");
    assert_eq!(f.base, "base line");
    assert_eq!(f.ours, "main line");
    assert_eq!(f.theirs, "feature line");

    let resolved = resolve_conflict_file(path.clone(), "shared.txt".into(), "theirs".into());
    assert!(resolved.ok, "resolve_conflict_file failed: {}", resolved.message);
    assert_eq!(resolved.remaining, 0);

    let cont = merge_continue(path.clone());
    assert!(cont.ok, "merge_continue failed: {}", cont.message);
    assert_eq!(cont.state, "clean");

    // Working tree now carries the "theirs" content, and the repo is no
    // longer mid-merge. HEAD is a new merge commit with two parents.
    assert_eq!(repo.read("shared.txt"), "feature line\n");
    let after = conflict_status(path.clone()).expect("conflict_status failed");
    assert!(!after.in_progress);
    assert_eq!(after.files.len(), 0);
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    let git2repo = repo.open();
    let head = git2repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 2, "merge_continue should conclude a real merge commit");
}

#[test]
fn merge_abort_restores_head() {
    let (repo, main_head, feature_tip) = build_conflicting_repo("merge_abort");
    let path = repo.path();

    let merged = merge_start(path.clone(), feature_tip);
    assert_eq!(merged.state, "conflict", "expected a conflict, got: {}", merged.message);
    assert_eq!(repo.open().state(), RepositoryState::Merge);

    let aborted = merge_abort(path.clone());
    assert!(aborted.ok, "merge_abort failed: {}", aborted.message);
    assert_eq!(aborted.state, "clean");

    // Full restoration: HEAD sha, repo state, and working tree content.
    assert_eq!(repo.rev("HEAD").as_deref(), Some(main_head.as_str()));
    assert_eq!(repo.open().state(), RepositoryState::Clean);
    assert_eq!(repo.read("shared.txt"), "main line\n");
    assert!(repo.is_clean());

    // Abort is idempotent when nothing is in progress.
    let again = merge_abort(path);
    assert!(again.ok);
    assert_eq!(again.state, "clean");
}

#[test]
fn merge_fast_forward_is_clean_and_moves_head() {
    let repo = TempRepo::init("merge_ff");
    let _base = repo.commit("f.txt", "base\n", "base");
    repo.must(&["branch", "feature"]);
    repo.must(&["checkout", "-q", "feature"]);
    let tip = repo.commit("f.txt", "feature line\n", "feature commit");
    repo.must(&["checkout", "-q", "main"]);
    let path = repo.path();

    let merged = merge_start(path.clone(), tip.clone());
    assert!(merged.ok, "expected a clean fast-forward, got: {}", merged.message);
    assert_eq!(merged.state, "clean");
    assert!(merged.backup_ref.is_some());
    assert_eq!(repo.rev("HEAD").as_deref(), Some(tip.as_str()));
    assert_eq!(repo.open().state(), RepositoryState::Clean);
    assert_eq!(repo.read("f.txt"), "feature line\n");
}

/// Regression test for a real bug an adversarial review caught: with an
/// ambient `merge.autoStash=true` (a real, non-default git convenience
/// setting), a dirty tree colliding with the incoming merge used to be
/// silently autostashed rather than refused — and if the autostash reapply
/// itself then conflicted, `merge_continue`/`merge_abort` would either error
/// ("no merge in progress") or `abort` would falsely report "clean" while
/// leaving real conflict markers behind. Fixed by always passing
/// `--no-autostash` (see merge_start's own comment). This test proves the
/// CLI flag wins over the config, not just that the default (unconfigured)
/// case was already safe.
#[test]
fn merge_refuses_a_dirty_conflicting_tree_even_when_autostash_is_configured() {
    let (repo, _main_head, feature_tip) = build_conflicting_repo("merge_autostash_guard");
    let path = repo.path();

    // Simulate the ambient convenience setting (repo-local is enough to prove
    // the CLI flag beats config; a user's real ~/.gitconfig works the same way).
    repo.must(&["config", "merge.autoStash", "true"]);

    // Uncommitted edit to the exact file the incoming merge touches.
    std::fs::write(std::path::Path::new(&path).join("shared.txt"), "dirty uncommitted edit\n")
        .expect("write dirty file");

    let merged = merge_start(path.clone(), feature_tip.clone());
    assert_eq!(merged.state, "error", "expected an upfront refusal, got state {:?}: {}", merged.state, merged.message);
    assert!(!merged.ok);
    assert_eq!(repo.open().state(), RepositoryState::Clean, "no merge should have started");
    assert_eq!(
        repo.read("shared.txt"),
        "dirty uncommitted edit\n",
        "the user's uncommitted edit must be left exactly as-is, not autostashed away"
    );
    assert!(repo.must(&["stash", "list"]).is_empty(), "no autostash entry should have been created");
}

#[test]
fn merge_already_up_to_date_is_empty_not_clean() {
    let repo = TempRepo::init("merge_noop");
    let _base = repo.commit("f.txt", "base\n", "base");
    let head = repo.rev("HEAD").unwrap();
    let path = repo.path();

    // Merging HEAD into itself is the simplest "nothing to do" case.
    let merged = merge_start(path.clone(), head.clone());
    assert_eq!(merged.state, "empty", "expected a benign no-op, got: {}", merged.message);
    assert!(!merged.ok);
    // Nothing was mutated: no snapshot side-effect surfaced to the user as a
    // real backup point, HEAD unchanged, tree unchanged.
    assert_eq!(repo.rev("HEAD").as_deref(), Some(head.as_str()));
    assert_eq!(repo.open().state(), RepositoryState::Clean);
}
