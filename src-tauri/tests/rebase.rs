//! Rebase + conflict resolver (model after tests/merge.rs / tests/cherry_pick.rs).
//!
//! Covers: a clean rebase with no conflicts; a single-conflict resolve ->
//! continue -> clean flow; and CRITICALLY a rebase with conflicts on TWO
//! commits in sequence, asserting that continuing past the first conflict
//! lands on the SECOND as "conflict" again (not falsely "clean") — this is
//! the regression guard for the empirically-tricky multi-conflict semantics
//! (see git_rebase.rs's module doc). Also covers rebase_start -> rebase_abort
//! (full restoration + idempotency) and rebase_skip (drop a conflicting
//! commit, assert it's gone from history and the rebase proceeds/concludes).

mod common;

use common::TempRepo;
use git2::RepositoryState;
use gitcat_lib::conflict::{conflict_status, resolve_conflict_file};
use gitcat_lib::git_rebase::{rebase_abort, rebase_continue, rebase_skip, rebase_start};

/// Builds a repo where `feature` has ONE commit that edits the same line of
/// the same file `main` also edited after the shared base — rebasing
/// `feature` onto `main` conflicts on that one commit.
/// Returns (repo, main_head_sha, feature_branch_original_tip_sha).
fn build_one_conflict_repo(tag: &str) -> (TempRepo, String, String) {
    let repo = TempRepo::init(tag);
    let _base = repo.commit("shared.txt", "base line\n", "base");
    repo.must(&["branch", "feature"]);

    let main_head = repo.commit("shared.txt", "main line\n", "edit on main");

    repo.must(&["checkout", "-q", "feature"]);
    let feature_tip = repo.commit("shared.txt", "feature line\n", "edit on feature");

    repo.must(&["checkout", "-q", "feature"]);
    assert_eq!(repo.rev("HEAD").as_deref(), Some(feature_tip.as_str()));

    (repo, main_head, feature_tip)
}

/// Builds a repo where `feature` has TWO commits, EACH editing a DIFFERENT
/// file that `main`'s single commit ALSO independently edited — rebasing
/// `feature` onto `main` conflicts on BOTH commits in sequence, one per file.
///
/// Two separate files (rather than two edits to the same file) are essential
/// here: resolving a conflict via "theirs" is a whole-file checkout, which
/// fully reconstructs the replayed commit's own tree for that file — so a
/// SECOND commit that keeps editing the SAME file would always find its
/// patch's preimage already restored (no second conflict). Decoupling the
/// edits onto independent files avoids that and produces two genuine,
/// independent conflicts. Returns (repo, main_head_sha).
fn build_two_conflict_repo(tag: &str) -> (TempRepo, String) {
    let repo = TempRepo::init(tag);
    repo.commit("a.txt", "base-a\n", "base a");
    let _base_b = repo.commit("b.txt", "base-b\n", "base b");
    repo.must(&["branch", "feature"]);

    // main edits BOTH files in one commit.
    std::fs::write(repo.dir.join("a.txt"), "main-a\n").expect("write a.txt");
    std::fs::write(repo.dir.join("b.txt"), "main-b\n").expect("write b.txt");
    repo.must(&["add", "-A"]);
    repo.must(&["commit", "-q", "--no-verify", "-m", "edit on main"]);
    let main_head = repo.must(&["rev-parse", "HEAD"]);

    // feature (branched before main's commit) edits each file in its OWN
    // commit: commit 1 touches only a.txt, commit 2 touches only b.txt.
    repo.must(&["checkout", "-q", "feature"]);
    repo.commit("a.txt", "feature-a\n", "feature edit 1 (a.txt)");
    repo.commit("b.txt", "feature-b\n", "feature edit 2 (b.txt)");

    (repo, main_head)
}

#[test]
fn rebase_clean_no_conflicts() {
    let repo = TempRepo::init("rebase_clean");
    let _base = repo.commit("f.txt", "base\n", "base");
    repo.must(&["branch", "feature"]);
    repo.must(&["checkout", "-q", "feature"]);
    let _f1 = repo.commit("g.txt", "feature file\n", "add g.txt on feature");
    repo.must(&["checkout", "-q", "main"]);
    let main_tip = repo.commit("h.txt", "main file\n", "add h.txt on main");
    let path = repo.path();

    repo.must(&["checkout", "-q", "feature"]);
    let out = rebase_start(path.clone(), "main".into());
    assert!(out.ok, "expected a clean rebase, got: {}", out.message);
    assert_eq!(out.state, "clean");
    assert!(out.backup_ref.is_some(), "rebase_start should snapshot before mutating");
    assert_eq!(repo.open().state(), RepositoryState::Clean);
    // feature's tip is now a new commit built on top of main's tip.
    let head = repo.rev("HEAD").unwrap();
    assert_ne!(head, main_tip, "rebase should have replayed feature's commit anew");
    let git2repo = repo.open();
    let head_commit = git2repo.head().unwrap().peel_to_commit().unwrap();
    let parent = head_commit.parent(0).unwrap();
    assert_eq!(parent.id().to_string(), main_tip, "rebased commit's parent should be main's tip");
    assert!(repo.is_clean());
    assert_eq!(repo.read("g.txt"), "feature file\n");
    assert_eq!(repo.read("h.txt"), "main file\n");
}

#[test]
fn rebase_already_up_to_date_is_empty_not_clean() {
    let repo = TempRepo::init("rebase_noop");
    let _base = repo.commit("f.txt", "base\n", "base");
    let head = repo.rev("HEAD").unwrap();
    let path = repo.path();

    // Rebasing HEAD onto itself is the simplest "nothing to do" case.
    let out = rebase_start(path.clone(), head.clone());
    assert_eq!(out.state, "empty", "expected a benign no-op, got: {}", out.message);
    assert!(!out.ok);
    assert_eq!(repo.rev("HEAD").as_deref(), Some(head.as_str()));
    assert_eq!(repo.open().state(), RepositoryState::Clean);
}

#[test]
fn rebase_one_conflict_resolve_theirs_then_continue() {
    let (repo, main_head, _feature_tip) = build_one_conflict_repo("rebase_one_conflict");
    let path = repo.path();

    let out = rebase_start(path.clone(), "main".into());
    assert_eq!(out.state, "conflict", "expected a conflict, got: {}", out.message);
    assert!(!out.ok);
    assert_eq!(out.conflicted_files, vec!["shared.txt".to_string()]);
    assert!(out.backup_ref.is_some(), "rebase_start should snapshot before mutating");
    assert_eq!(repo.open().state(), RepositoryState::RebaseInteractive);

    let status = conflict_status(path.clone()).expect("conflict_status failed");
    assert!(status.in_progress);
    assert_eq!(status.op, "rebase");
    assert_eq!(status.files.len(), 1);
    let f = &status.files[0];
    assert_eq!(f.path, "shared.txt");
    assert_eq!(f.base, "base line");
    assert_eq!(f.ours, "main line");
    assert_eq!(f.theirs, "feature line");

    let resolved = resolve_conflict_file(path.clone(), "shared.txt".into(), "theirs".into());
    assert!(resolved.ok, "resolve_conflict_file failed: {}", resolved.message);
    assert_eq!(resolved.remaining, 0);

    let cont = rebase_continue(path.clone());
    assert!(cont.ok, "rebase_continue failed: {}", cont.message);
    assert_eq!(cont.state, "clean");

    assert_eq!(repo.read("shared.txt"), "feature line\n");
    let after = conflict_status(path.clone()).expect("conflict_status failed");
    assert!(!after.in_progress);
    assert_eq!(after.files.len(), 0);
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    let git2repo = repo.open();
    let head = git2repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 1, "rebase_continue should conclude a normal (non-merge) commit");
    let parent = head.parent(0).unwrap();
    assert_eq!(parent.id().to_string(), main_head, "rebased commit's parent should be main's tip");
}

/// THE regression guard for the empirically-tricky multi-conflict semantics:
/// resolve the first conflicting commit, continue, and assert the state is
/// STILL "conflict" (the second commit), not falsely "clean" — then resolve
/// the second and continue to a real "clean".
#[test]
fn rebase_two_conflicts_in_sequence_continue_reports_conflict_then_clean() {
    let (repo, main_head) = build_two_conflict_repo("rebase_two_conflicts");
    let path = repo.path();

    let out = rebase_start(path.clone(), "main".into());
    assert_eq!(out.state, "conflict", "expected first conflict, got: {}", out.message);
    assert_eq!(out.conflicted_files, vec!["a.txt".to_string()]);
    assert_eq!(repo.open().state(), RepositoryState::RebaseInteractive);

    // Resolve the FIRST conflicting commit (a.txt).
    let resolved1 = resolve_conflict_file(path.clone(), "a.txt".into(), "theirs".into());
    assert!(resolved1.ok, "first resolve failed: {}", resolved1.message);
    assert_eq!(resolved1.remaining, 0);

    // Continue past it — this MUST land on the SECOND conflicting commit
    // (b.txt), reporting "conflict" again, not "clean".
    let cont1 = rebase_continue(path.clone());
    assert_eq!(
        cont1.state, "conflict",
        "continuing past the first conflict should hit the SECOND conflicting commit, not report clean; message: {}",
        cont1.message
    );
    assert!(!cont1.ok);
    assert_eq!(cont1.conflicted_files, vec!["b.txt".to_string()]);
    assert_eq!(
        repo.open().state(),
        RepositoryState::RebaseInteractive,
        "repo should still be mid-rebase for the second conflict"
    );

    let status = conflict_status(path.clone()).expect("conflict_status failed");
    assert!(status.in_progress);
    assert_eq!(status.op, "rebase");
    assert_eq!(status.files.len(), 1);
    assert_eq!(status.files[0].path, "b.txt");

    // Resolve the SECOND conflicting commit (b.txt).
    let resolved2 = resolve_conflict_file(path.clone(), "b.txt".into(), "theirs".into());
    assert!(resolved2.ok, "second resolve failed: {}", resolved2.message);
    assert_eq!(resolved2.remaining, 0);

    let cont2 = rebase_continue(path.clone());
    assert!(cont2.ok, "final rebase_continue failed: {}", cont2.message);
    assert_eq!(cont2.state, "clean");
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    // Both feature commits replayed onto main, in order, each a single-parent
    // (non-merge) commit; final content is each commit's own resolution.
    assert_eq!(repo.read("a.txt"), "feature-a\n");
    assert_eq!(repo.read("b.txt"), "feature-b\n");
    let git2repo = repo.open();
    let head = git2repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 1);
    let parent = head.parent(0).unwrap();
    assert_eq!(parent.parent_count(), 1);
    let grandparent = parent.parent(0).unwrap();
    assert_eq!(grandparent.id().to_string(), main_head, "the rebased chain should be rooted on main's tip");
}

#[test]
fn rebase_abort_restores_head_and_is_idempotent() {
    let (repo, _main_head, feature_tip) = build_one_conflict_repo("rebase_abort");
    let path = repo.path();

    let out = rebase_start(path.clone(), "main".into());
    assert_eq!(out.state, "conflict", "expected a conflict, got: {}", out.message);
    assert_eq!(repo.open().state(), RepositoryState::RebaseInteractive);

    let aborted = rebase_abort(path.clone());
    assert!(aborted.ok, "rebase_abort failed: {}", aborted.message);
    assert_eq!(aborted.state, "clean");

    // Full restoration: HEAD sha, repo state, branch, and working tree content.
    assert_eq!(repo.rev("HEAD").as_deref(), Some(feature_tip.as_str()));
    assert_eq!(repo.current_branch(), "feature");
    assert_eq!(repo.open().state(), RepositoryState::Clean);
    assert_eq!(repo.read("shared.txt"), "feature line\n");
    assert!(repo.is_clean());

    // Abort is idempotent when nothing is in progress.
    let again = rebase_abort(path);
    assert!(again.ok);
    assert_eq!(again.state, "clean");
}

#[test]
fn rebase_skip_drops_the_conflicting_commit_and_proceeds() {
    let (repo, main_head) = build_two_conflict_repo("rebase_skip");
    let path = repo.path();

    let out = rebase_start(path.clone(), "main".into());
    assert_eq!(out.state, "conflict", "expected first conflict, got: {}", out.message);
    assert_eq!(out.conflicted_files, vec!["a.txt".to_string()]);

    // Skip the FIRST conflicting commit (a.txt) entirely — this should land
    // on the SECOND conflicting commit (b.txt), still "conflict", not "clean".
    let skipped = rebase_skip(path.clone());
    assert_eq!(
        skipped.state, "conflict",
        "skipping the first commit should land on the second conflict; message: {}",
        skipped.message
    );
    assert_eq!(skipped.conflicted_files, vec!["b.txt".to_string()]);
    assert_eq!(repo.open().state(), RepositoryState::RebaseInteractive);

    // Resolve + continue the second, finishing the rebase.
    let resolved = resolve_conflict_file(path.clone(), "b.txt".into(), "theirs".into());
    assert!(resolved.ok, "resolve failed: {}", resolved.message);
    let cont = rebase_continue(path.clone());
    assert!(cont.ok, "rebase_continue failed: {}", cont.message);
    assert_eq!(cont.state, "clean");
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    // The skipped commit ("feature edit 1 (a.txt)") must be gone from
    // history: only ONE commit sits between main's tip and the new HEAD
    // (feature edit 2), and a.txt keeps MAIN's content (never touched by the
    // dropped commit), while b.txt carries feature's resolved content.
    let git2repo = repo.open();
    let head = git2repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 1);
    assert_eq!(head.message().unwrap_or("").trim(), "feature edit 2 (b.txt)");
    let parent = head.parent(0).unwrap();
    assert_eq!(
        parent.id().to_string(),
        main_head,
        "the skipped commit should be gone — HEAD's parent should be main's tip directly"
    );
    assert_eq!(repo.read("a.txt"), "main-a\n", "a.txt should keep main's content — the commit that touched it was skipped");
    assert_eq!(repo.read("b.txt"), "feature-b\n");
}
