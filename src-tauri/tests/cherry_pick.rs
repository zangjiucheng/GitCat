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

    let picked = cherry_pick(path.clone(), feature_tip.clone(), Some(true));
    assert_eq!(picked.state, "conflict", "expected a conflict, got: {}", picked.message);
    assert!(!picked.ok);
    assert_eq!(picked.conflicted_files, vec!["shared.txt".to_string()]);
    assert!(picked.backup_ref.is_some(), "cherry_pick should snapshot before mutating");

    let status = conflict_status(path.clone()).expect("conflict_status failed");
    assert!(status.in_progress);
    assert_eq!(status.op, "cherry-pick");
    assert_eq!(status.files.len(), 1);
    let f = &status.files[0];
    assert_eq!(f.path, "shared.txt");
    assert_eq!(f.base, "base line");
    assert_eq!(f.ours, "main line");
    assert_eq!(f.theirs, "feature line");

    let resolved = resolve_conflict_file(path.clone(), "shared.txt".into(), "theirs".into());
    assert!(resolved.ok, "resolve_conflict_file failed: {}", resolved.message);
    assert_eq!(resolved.remaining, 0);

    let cont = cherry_pick_continue(path.clone());
    assert!(cont.ok, "cherry_pick_continue failed: {}", cont.message);
    assert_eq!(cont.state, "clean");

    // Working tree now carries the "theirs" content, and the repo is no
    // longer mid-pick.
    assert_eq!(repo.read("shared.txt"), "feature line\n");
    let after = conflict_status(path.clone()).expect("conflict_status failed");
    assert!(!after.in_progress);
    assert_eq!(after.files.len(), 0);
    assert_eq!(repo.open().state(), RepositoryState::Clean);
}

#[test]
fn cherry_pick_abort_restores_head() {
    let (repo, main_head, feature_tip) = build_conflicting_repo("pick_abort");
    let path = repo.path();

    let picked = cherry_pick(path.clone(), feature_tip, Some(true));
    assert_eq!(picked.state, "conflict", "expected a conflict, got: {}", picked.message);
    assert_eq!(repo.open().state(), RepositoryState::CherryPick);

    let aborted = cherry_pick_abort(path.clone());
    assert!(aborted.ok, "cherry_pick_abort failed: {}", aborted.message);
    assert_eq!(aborted.state, "clean");

    // Full restoration: HEAD sha, repo state, and working tree content.
    assert_eq!(repo.rev("HEAD").as_deref(), Some(main_head.as_str()));
    assert_eq!(repo.open().state(), RepositoryState::Clean);
    assert_eq!(repo.read("shared.txt"), "main line\n");
    assert!(repo.is_clean());

    // Abort is idempotent when nothing is in progress.
    let again = cherry_pick_abort(path);
    assert!(again.ok);
    assert_eq!(again.state, "clean");
}
