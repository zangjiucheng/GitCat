//! Revert + conflict resolver (model after tests/merge.rs / tests/cherry_pick.rs).
//!
//! Covers: a clean revert producing a real inverse-diff commit with a
//! "Revert ..." message (and snapshot-first: the backup ref pins the
//! PRE-revert HEAD); a revert of a change that's already absent from the tree
//! reporting "empty" (mirrors cherry-pick's empty case, but see git_revert.rs's
//! doc comment for why revert's empty signature on the wire is different); a
//! real conflict resolved end to end via conflict_status + resolve_conflict_file
//! -> revert_continue (asserting real base/ours/theirs text AND
//! `op == "revert"`); the same induced conflict backed out via revert_abort
//! (full restoration, idempotent); revert_abort's "must always be
//! runnable" guarantee even when nothing was ever snapshotted or reverted;
//! and the empty-revert case staying correctly classified even under a
//! non-English process locale (regression test for git_revert.rs's `git()`
//! not forcing `LC_ALL=C`/`LANGUAGE=""` the way git_bisect.rs's does).

mod common;

use common::TempRepo;
use git2::RepositoryState;
use gitcat_lib::conflict::{conflict_status, resolve_conflict_file};
use gitcat_lib::git_revert::{revert_abort, revert_continue, revert_start};

/// Builds a repo where reverting `to_revert` (which changed `f.txt` from
/// "base" to "A") conflicts with a later edit on the same line (`head_b`
/// changes it again to "B"). Returns (repo, head_b_sha, to_revert_sha).
fn build_conflicting_repo(tag: &str) -> (TempRepo, String, String) {
    let repo = TempRepo::init(tag);
    let _base = repo.commit("f.txt", "base\n", "base");
    let to_revert = repo.commit("f.txt", "A\n", "edit to A");
    let head_b = repo.commit("f.txt", "B\n", "edit to B");
    (repo, head_b, to_revert)
}

#[test]
fn revert_clean_produces_inverse_commit_with_revert_message() {
    let repo = TempRepo::init("revert_clean");
    let _base = repo.commit("f.txt", "base\n", "base");
    let added = repo.commit("f.txt", "base\nline2\n", "add line2");
    let path = repo.path();

    let result = revert_start(path.clone(), added.clone(), None);
    assert!(result.ok, "expected a clean revert, got: {}", result.message);
    assert_eq!(result.state, "clean");
    assert!(result.conflicted_files.is_empty());
    let backup = result
        .backup_ref
        .clone()
        .expect("revert_start should snapshot before mutating");

    // Snapshot-first: the backup ref must pin the PRE-revert HEAD (the commit
    // being reverted) — proof the snapshot was taken BEFORE the new commit
    // landed, not after.
    assert_eq!(repo.rev(&backup).as_deref(), Some(added.as_str()));

    // A real new commit landed on top of the reverted commit, with an inverse
    // diff and a "Revert ..." style message.
    let git2repo = repo.open();
    let head_commit = git2repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head_commit.parent_count(), 1);
    assert_eq!(head_commit.parent_id(0).unwrap().to_string(), added);
    let msg = head_commit.message().unwrap_or("");
    assert!(msg.starts_with("Revert "), "expected a 'Revert ...' message, got: {msg:?}");
    assert!(msg.contains(&added), "revert message should name the reverted sha: {msg:?}");

    assert_eq!(repo.read("f.txt"), "base\n");
    assert_eq!(git2repo.state(), RepositoryState::Clean);
    assert!(repo.is_clean());
}

#[test]
fn revert_of_change_not_present_is_empty_not_clean() {
    let repo = TempRepo::init("revert_empty");
    let _base = repo.commit("f.txt", "base\n", "base");
    let added = repo.commit("f.txt", "base\nline2\n", "add line2");
    // Manually undo the same change a different way, so `added`'s diff is
    // already absent from the tree before we ever try to revert it.
    let head_before = repo.commit("f.txt", "base\n", "manually remove line2");
    let path = repo.path();

    let result = revert_start(path.clone(), added, None);
    assert_eq!(result.state, "empty", "expected a benign no-op, got: {}", result.message);
    assert!(!result.ok);
    assert!(result.conflicted_files.is_empty());
    // We still snapshot before attempting — the no-op is discovered only once
    // git actually tries and finds nothing to commit.
    assert!(result.backup_ref.is_some());

    // Nothing was mutated: HEAD unchanged, tree unchanged, no leftover
    // sequencer state.
    assert_eq!(repo.rev("HEAD").as_deref(), Some(head_before.as_str()));
    assert_eq!(repo.open().state(), RepositoryState::Clean);
    assert!(repo.is_clean());
}

#[test]
fn revert_conflict_resolve_theirs_then_continue() {
    let (repo, _head_b, to_revert) = build_conflicting_repo("revert_resolve");
    let path = repo.path();

    let reverted = revert_start(path.clone(), to_revert.clone(), None);
    assert_eq!(reverted.state, "conflict", "expected a conflict, got: {}", reverted.message);
    assert!(!reverted.ok);
    assert_eq!(reverted.conflicted_files, vec!["f.txt".to_string()]);
    assert!(reverted.backup_ref.is_some(), "revert_start should snapshot before mutating");
    assert_eq!(repo.open().state(), RepositoryState::Revert);

    let status = conflict_status(path.clone()).expect("conflict_status failed");
    assert!(status.in_progress);
    assert_eq!(status.op, "revert");
    assert_eq!(status.files.len(), 1);
    let f = &status.files[0];
    assert_eq!(f.path, "f.txt");
    // Revert's 3-way merge: ancestor = the commit being reverted ("A"),
    // ours = current HEAD ("B"), theirs = the state revert is moving toward
    // (the reverted commit's parent, "base") — verified empirically.
    assert_eq!(f.base, "A");
    assert_eq!(f.ours, "B");
    assert_eq!(f.theirs, "base");

    // Accept the revert ("theirs" = the reverted-to state).
    let resolved = resolve_conflict_file(path.clone(), "f.txt".into(), "theirs".into());
    assert!(resolved.ok, "resolve_conflict_file failed: {}", resolved.message);
    assert_eq!(resolved.remaining, 0);

    let cont = revert_continue(path.clone());
    assert!(cont.ok, "revert_continue failed: {}", cont.message);
    assert_eq!(cont.state, "clean");

    assert_eq!(repo.read("f.txt"), "base\n");
    let after = conflict_status(path.clone()).expect("conflict_status failed");
    assert!(!after.in_progress);
    assert_eq!(after.files.len(), 0);
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    let git2repo = repo.open();
    let head = git2repo.head().unwrap().peel_to_commit().unwrap();
    let msg = head.message().unwrap_or("");
    assert!(msg.starts_with("Revert "), "expected a 'Revert ...' message, got: {msg:?}");
}

#[test]
fn revert_abort_restores_head() {
    let (repo, head_b, to_revert) = build_conflicting_repo("revert_abort");
    let path = repo.path();

    let reverted = revert_start(path.clone(), to_revert, None);
    assert_eq!(reverted.state, "conflict", "expected a conflict, got: {}", reverted.message);
    assert_eq!(repo.open().state(), RepositoryState::Revert);

    let aborted = revert_abort(path.clone());
    assert!(aborted.ok, "revert_abort failed: {}", aborted.message);
    assert_eq!(aborted.state, "clean");

    // Full restoration: HEAD sha, repo state, and working tree content.
    assert_eq!(repo.rev("HEAD").as_deref(), Some(head_b.as_str()));
    assert_eq!(repo.open().state(), RepositoryState::Clean);
    assert_eq!(repo.read("f.txt"), "B\n");
    assert!(repo.is_clean());

    // Abort is idempotent when nothing is in progress.
    let again = revert_abort(path);
    assert!(again.ok);
    assert_eq!(again.state, "clean");
}

/// Regression test for a locale bug: `git_revert.rs`'s own `git()` CLI runner
/// did NOT force `LC_ALL=C`/`LANGUAGE=""` (unlike `git_bisect.rs`'s `git()`,
/// which does exactly that) even though `classify()` depends on English prose
/// for its ONE documented benign scrape — matching "nothing to commit" to
/// detect a benign empty revert. Under a non-English locale, git translates
/// that message (empirically confirmed on this machine, git 2.53.0: under
/// `LC_ALL=fr_FR.UTF-8` the same empty-revert scenario prints "rien à
/// valider, la copie de travail est propre" instead), so the substring match
/// would fail and `classify` would fall through to `state:"error"` for what is
/// actually a benign empty revert.
///
/// This sets the CURRENT PROCESS's `LC_ALL`/`LANGUAGE` to French — the locale
/// `git()`'s `Command` would otherwise inherit from its parent if it didn't
/// explicitly override them — and asserts the empty-revert case still comes
/// back as `state:"empty"`. Before the fix (git() not setting LC_ALL/LANGUAGE
/// on the Command), this test fails with `state == "error"` and a French
/// message; restore the env vars afterward (a `Drop` guard) so this doesn't
/// leak into other tests in this binary that run concurrently.
#[test]
fn revert_empty_is_classified_correctly_under_a_non_english_locale() {
    struct RestoreEnv(&'static str, Option<String>);
    impl Drop for RestoreEnv {
        fn drop(&mut self) {
            match &self.1 {
                Some(v) => std::env::set_var(self.0, v),
                None => std::env::remove_var(self.0),
            }
        }
    }
    let _restore_lc_all = RestoreEnv("LC_ALL", std::env::var("LC_ALL").ok());
    let _restore_language = RestoreEnv("LANGUAGE", std::env::var("LANGUAGE").ok());
    std::env::set_var("LC_ALL", "fr_FR.UTF-8");
    std::env::set_var("LANGUAGE", "fr_FR.UTF-8");

    let repo = TempRepo::init("revert_empty_locale");
    let _base = repo.commit("f.txt", "base\n", "base");
    let added = repo.commit("f.txt", "base\nline2\n", "add line2");
    // Manually undo the same change a different way, so `added`'s diff is
    // already absent from the tree before we ever try to revert it (same
    // setup as `revert_of_change_not_present_is_empty_not_clean` above).
    let head_before = repo.commit("f.txt", "base\n", "manually remove line2");
    let path = repo.path();

    let result = revert_start(path.clone(), added, None);
    assert_eq!(
        result.state, "empty",
        "expected a benign no-op even under a French locale, got state={:?} message={:?}",
        result.state, result.message
    );
    assert!(!result.ok);
    assert!(result.conflicted_files.is_empty());

    // Nothing was mutated, exactly like the English-locale empty case.
    assert_eq!(repo.rev("HEAD").as_deref(), Some(head_before.as_str()));
    assert_eq!(repo.open().state(), RepositoryState::Clean);
    assert!(repo.is_clean());
}

#[test]
fn revert_blocked_by_dirty_tree_reports_blocked_by_local_changes() {
    let (repo, _head_b, to_revert) = build_conflicting_repo("revert_dirty_block");
    let path = repo.path();

    // Dirty f.txt (unstaged) in a way that collides with what the revert would touch.
    std::fs::write(repo.dir.join("f.txt"), "dirty, uncommitted\n").unwrap();
    assert!(!repo.is_clean());

    let reverted = revert_start(path.clone(), to_revert, None);
    assert!(!reverted.ok);
    assert_eq!(reverted.state, "error", "expected a dirty-tree refusal, got state {:?}: {}", reverted.state, reverted.message);
    assert!(reverted.blocked_by_local_changes, "expected blocked_by_local_changes=true: {}", reverted.message);
    assert!(reverted.backup_ref.is_some(), "revert_start snapshots before running git, even on a refusal it caused");
    assert!(reverted.conflicted_files.is_empty());
    assert_eq!(repo.read("f.txt"), "dirty, uncommitted\n");
    assert_eq!(repo.open().state(), RepositoryState::Clean);
}

#[test]
fn revert_bad_revision_is_not_reported_as_blocked_by_local_changes() {
    let repo = TempRepo::init("revert_bad_rev");
    let _base = repo.commit("f.txt", "base\n", "base");
    let path = repo.path();

    let reverted = revert_start(path, "not-a-real-sha".into(), None);
    assert!(!reverted.ok);
    assert_eq!(reverted.state, "error");
    assert!(!reverted.blocked_by_local_changes, "a bad revision must not be misclassified as a dirty-tree block: {}", reverted.message);
}

#[test]
fn revert_abort_is_always_runnable_even_with_no_snapshot_ever_taken() {
    // A repo where NOTHING has ever been snapshotted, reverted, or otherwise
    // mutated by GitCat — revert_abort (the escape hatch) must still be safely
    // callable, exactly like merge_abort's doc comment promises for merge.
    let repo = TempRepo::init("revert_abort_fresh");
    let _base = repo.commit("f.txt", "base\n", "base");
    let path = repo.path();

    let aborted = revert_abort(path);
    assert!(aborted.ok, "revert_abort failed: {}", aborted.message);
    assert_eq!(aborted.state, "clean");
    assert_eq!(aborted.message, "No revert in progress.");
}
