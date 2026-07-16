//! Merge + conflict resolver (model after tests/cherry_pick.rs).
//!
//! Drives a real conflicting merge end to end: merge_start -> conflict_status
//! (asserting real ours/base/theirs text AND `op == "merge"`) -> resolve_
//! conflict_file ("theirs") -> merge_continue (asserting MergeResult.state ==
//! "clean") — and, separately, a merge_start -> merge_abort flow that fully
//! restores HEAD and RepositoryState::Clean (with full idempotency). Also
//! covers a clean fast-forward merge and the "already up to date" no-op.
//!
//! Also covers the explicit ff/no-ff `strategy` param (backlog #7) and the
//! squash-merge command trio (`merge_squash`/`merge_squash_abort`/
//! `merge_squash_continue`), including that a squash conflict is reported by
//! `conflict_status` as its own `"merge-squash"` op — distinct from a stash
//! conflict (`tests/workdir.rs`'s `"stash"` op) even though both leave
//! `RepositoryState::Clean` with unmerged index entries.

mod common;

use common::TempRepo;
use git2::RepositoryState;
use gitcat_lib::conflict::{conflict_file_hunks, conflict_status, resolve_conflict_file, resolve_conflict_hunks};
use gitcat_lib::git_merge::{
    merge_abort, merge_continue, merge_queue_abort, merge_queue_continue, merge_queue_status, merge_squash,
    merge_squash_abort, merge_squash_continue, merge_start, merge_start_multi,
};

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

    let merged = merge_start(path.clone(), feature_tip.clone(), None);
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

    let merged = merge_start(path.clone(), feature_tip, None);
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

    let merged = merge_start(path.clone(), tip.clone(), None);
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

    let merged = merge_start(path.clone(), feature_tip.clone(), None);
    assert_eq!(merged.state, "error", "expected an upfront refusal, got state {:?}: {}", merged.state, merged.message);
    assert!(!merged.ok);
    assert!(merged.blocked_by_local_changes, "expected blocked_by_local_changes=true: {}", merged.message);
    assert!(merged.backup_ref.is_some(), "merge_start snapshots before running git, even on a refusal it caused");
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
    let merged = merge_start(path.clone(), head.clone(), None);
    assert_eq!(merged.state, "empty", "expected a benign no-op, got: {}", merged.message);
    assert!(!merged.ok);
    // Nothing was mutated: no snapshot side-effect surfaced to the user as a
    // real backup point, HEAD unchanged, tree unchanged.
    assert_eq!(repo.rev("HEAD").as_deref(), Some(head.as_str()));
    assert_eq!(repo.open().state(), RepositoryState::Clean);
}

// ---------------------------------------------------------------------------
// Explicit ff/no-ff strategy (backlog #7)
// ---------------------------------------------------------------------------

#[test]
fn merge_no_ff_forces_a_merge_commit_even_when_a_fast_forward_is_possible() {
    let repo = TempRepo::init("merge_no_ff");
    let _base = repo.commit("f.txt", "base\n", "base");
    repo.must(&["branch", "feature"]);
    repo.must(&["checkout", "-q", "feature"]);
    let tip = repo.commit("f.txt", "feature line\n", "feature commit");
    repo.must(&["checkout", "-q", "main"]);
    let path = repo.path();

    let merged = merge_start(path.clone(), tip.clone(), Some("no-ff".into()));
    assert!(merged.ok, "expected a clean merge, got: {}", merged.message);
    assert_eq!(merged.state, "clean");

    let git2repo = repo.open();
    let head = git2repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 2, "--no-ff must create a real merge commit even though a ff was possible");
    assert_ne!(
        repo.rev("HEAD").as_deref(),
        Some(tip.as_str()),
        "HEAD must be a NEW merge commit, not simply the fast-forwarded tip"
    );
    assert_eq!(repo.read("f.txt"), "feature line\n");
}

#[test]
fn merge_ff_only_refuses_when_diverged_and_succeeds_when_ff_is_possible() {
    // Diverged (here: outright conflicting) case: --ff-only must refuse
    // cleanly BEFORE ever attempting the merge — nothing mutated, no
    // MERGE_HEAD, no conflict markers.
    let (repo, main_head, feature_tip) = build_conflicting_repo("merge_ff_only_diverged");
    let path = repo.path();

    let merged = merge_start(path.clone(), feature_tip.clone(), Some("ff-only".into()));
    assert_eq!(merged.state, "error", "expected a clean refusal, got: {}", merged.message);
    assert!(!merged.ok);
    assert!(!merged.blocked_by_local_changes, "an --ff-only refusal must not be misclassified as a dirty-tree block: {}", merged.message);
    assert_eq!(repo.rev("HEAD").as_deref(), Some(main_head.as_str()), "HEAD must not move");
    assert_eq!(repo.open().state(), RepositoryState::Clean, "no merge should have started");
    assert!(repo.is_clean(), "the working tree must be untouched");

    // Fast-forwardable case: succeeds exactly like "auto" would.
    let repo2 = TempRepo::init("merge_ff_only_possible");
    let _base = repo2.commit("f.txt", "base\n", "base");
    repo2.must(&["branch", "feature"]);
    repo2.must(&["checkout", "-q", "feature"]);
    let tip2 = repo2.commit("f.txt", "feature line\n", "feature commit");
    repo2.must(&["checkout", "-q", "main"]);
    let path2 = repo2.path();

    let merged2 = merge_start(path2.clone(), tip2.clone(), Some("ff-only".into()));
    assert!(merged2.ok, "expected a clean fast-forward, got: {}", merged2.message);
    assert_eq!(merged2.state, "clean");
    assert_eq!(repo2.rev("HEAD").as_deref(), Some(tip2.as_str()));
}

#[test]
fn merge_start_rejects_an_unknown_strategy() {
    let repo = TempRepo::init("merge_unknown_strategy");
    let _base = repo.commit("f.txt", "base\n", "base");
    let head = repo.rev("HEAD").unwrap();
    let path = repo.path();

    let merged = merge_start(path.clone(), head.clone(), Some("squash".into()));
    assert_eq!(merged.state, "error");
    assert!(!merged.ok);
    assert!(merged.message.contains("Unknown merge strategy"), "message: {}", merged.message);
    // Nothing should have been touched — this must fail validation before
    // ever opening the repo/snapshotting.
    assert_eq!(repo.rev("HEAD").as_deref(), Some(head.as_str()));
}

// ---------------------------------------------------------------------------
// Squash-merge (backlog #7): stage a diff into the index without committing
// ---------------------------------------------------------------------------

#[test]
fn merge_squash_clean_stages_everything_without_committing_or_moving_ref() {
    let repo = TempRepo::init("squash_clean");
    let _base = repo.commit("f.txt", "base\n", "base");
    let head_before = repo.rev("HEAD").unwrap();
    repo.must(&["branch", "feature"]);
    repo.must(&["checkout", "-q", "feature"]);
    let tip = repo.commit("f.txt", "feature line\n", "feature commit");
    repo.must(&["checkout", "-q", "main"]);
    let path = repo.path();

    let squashed = merge_squash(path.clone(), tip.clone());
    assert!(squashed.ok, "expected a clean squash, got: {}", squashed.message);
    assert_eq!(squashed.state, "staged");
    assert!(squashed.backup_ref.is_some(), "merge_squash should snapshot before mutating");
    let msg = squashed.suggested_message.clone().unwrap_or_default();
    assert!(msg.contains("feature commit"), "suggested message should mention the squashed commit: {msg}");

    // No commit, no ref move — HEAD is unchanged, but the diff IS staged.
    assert_eq!(repo.rev("HEAD").as_deref(), Some(head_before.as_str()), "squash must never move HEAD");
    assert_eq!(repo.must(&["diff", "--cached", "--name-only"]), "f.txt");
    assert_eq!(repo.read("f.txt"), "feature line\n");
    assert_eq!(repo.open().state(), RepositoryState::Clean);
    assert!(!repo.dir.join(".git").join("MERGE_HEAD").exists());

    // Handoff: committing now (the existing Workdir commit flow) finishes it
    // as a plain single-parent commit — never a merge commit.
    repo.must(&["commit", "-q", "-m", "manual squash commit"]);
    let git2repo = repo.open();
    let head = git2repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 1, "a squash commit must be a plain single-parent commit");
    assert!(!repo.dir.join(".git").join("SQUASH_MSG").exists(), "a real commit must consume SQUASH_MSG");
}

#[test]
fn merge_squash_already_up_to_date_is_empty_not_staged() {
    let repo = TempRepo::init("squash_noop");
    let _base = repo.commit("f.txt", "base\n", "base");
    let head = repo.rev("HEAD").unwrap();
    let path = repo.path();

    // Squashing HEAD into itself is the simplest "nothing to squash" case.
    let squashed = merge_squash(path.clone(), head.clone());
    assert_eq!(squashed.state, "empty", "expected a benign no-op, got: {}", squashed.message);
    assert!(!squashed.ok);
    assert_eq!(repo.rev("HEAD").as_deref(), Some(head.as_str()));
    assert!(repo.is_clean());
    assert!(!repo.dir.join(".git").join("SQUASH_MSG").exists(), "a no-op squash must not write SQUASH_MSG");
}

#[test]
fn merge_squash_conflict_leaves_no_merge_head_and_is_reported_as_merge_squash() {
    let (repo, _main_head, feature_tip) = build_conflicting_repo("squash_conflict_reporting");
    let path = repo.path();

    let squashed = merge_squash(path.clone(), feature_tip);
    assert_eq!(squashed.state, "conflict", "expected a conflict, got: {}", squashed.message);
    assert!(!squashed.ok);
    assert_eq!(squashed.conflicted_files, vec!["shared.txt".to_string()]);
    assert!(squashed.backup_ref.is_some(), "merge_squash should snapshot before mutating");
    assert_eq!(repo.open().state(), RepositoryState::Clean, "a squash conflict must NEVER set MERGE_HEAD");
    assert!(!repo.dir.join(".git").join("MERGE_HEAD").exists());

    let status = conflict_status(path.clone()).expect("conflict_status failed");
    assert!(status.in_progress);
    assert_eq!(status.op, "merge-squash", "a Clean-state squash conflict must report op \"merge-squash\"");
    assert_eq!(status.files.len(), 1);
    assert_eq!(status.files[0].path, "shared.txt");
}

#[test]
fn merge_squash_abort_restores_pre_squash_state() {
    let (repo, main_head, feature_tip) = build_conflicting_repo("squash_abort");
    let path = repo.path();

    let squashed = merge_squash(path.clone(), feature_tip);
    assert_eq!(squashed.state, "conflict", "expected a conflict, got: {}", squashed.message);

    let aborted = merge_squash_abort(path.clone());
    assert!(aborted.ok, "merge_squash_abort failed: {}", aborted.message);
    assert_eq!(aborted.state, "clean");
    assert!(repo.is_clean(), "abort should restore a clean tree");
    assert_eq!(repo.rev("HEAD").as_deref(), Some(main_head.as_str()));
    assert_eq!(repo.read("shared.txt"), "main line\n", "abort should restore the pre-squash content");
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    let status = conflict_status(path.clone()).expect("conflict_status failed");
    assert!(!status.in_progress, "sidecar must be cleared once aborted");

    // Idempotent-ish escape hatch: a second abort with nothing outstanding is
    // a clean refusal, never a crash.
    let again = merge_squash_abort(path);
    assert!(!again.ok);
    assert_eq!(again.state, "error");
}

#[test]
fn merge_squash_continue_after_resolving_clears_sidecar_and_returns_suggested_message() {
    let (repo, _main_head, feature_tip) = build_conflicting_repo("squash_continue");
    let path = repo.path();

    let squashed = merge_squash(path.clone(), feature_tip);
    assert_eq!(squashed.state, "conflict", "expected a conflict, got: {}", squashed.message);

    let resolved = resolve_conflict_file(path.clone(), "shared.txt".into(), "theirs".into());
    assert!(resolved.ok, "resolve_conflict_file failed: {}", resolved.message);
    assert_eq!(resolved.remaining, 0);

    let cont = merge_squash_continue(path.clone());
    assert!(cont.ok, "merge_squash_continue failed: {}", cont.message);
    assert_eq!(cont.state, "staged", "squash's Continue is never \"clean\" — a real commit is still owed");
    assert!(cont.suggested_message.is_some(), "should surface .git/SQUASH_MSG's content");
    assert_eq!(repo.read("shared.txt"), "feature line\n", "\"theirs\" should have been kept");
    assert_eq!(repo.must(&["diff", "--name-only", "--diff-filter=U"]), "", "no unmerged paths should remain");
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    let status = conflict_status(path.clone()).expect("conflict_status failed");
    assert!(!status.in_progress, "sidecar must be cleared once resolved");

    // Handoff: committing finishes it as a plain, single-parent commit.
    repo.must(&["commit", "-q", "-m", "resolved squash"]);
    let git2repo = repo.open();
    let head = git2repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 1);
}

#[test]
fn merge_squash_continue_still_conflicted_reports_conflict_again() {
    let (repo, _main_head, feature_tip) = build_conflicting_repo("squash_continue_still_conflicted");
    let path = repo.path();

    let squashed = merge_squash(path.clone(), feature_tip);
    assert_eq!(squashed.state, "conflict");

    // Continue BEFORE resolving anything — must refuse, not silently finish.
    let cont = merge_squash_continue(path.clone());
    assert!(!cont.ok);
    assert_eq!(cont.state, "conflict");
    assert_eq!(cont.conflicted_files, vec!["shared.txt".to_string()]);

    // The sidecar must still be intact — Abort still works after a failed Continue.
    let aborted = merge_squash_abort(path);
    assert!(aborted.ok, "merge_squash_abort failed: {}", aborted.message);
}

// ---------------------------------------------------------------------------
// A squash conflict and a stash conflict must never be confused, even though
// both leave RepositoryState::Clean with unmerged index entries (see
// conflict.rs::detect_op's doc comment).
// ---------------------------------------------------------------------------

#[test]
fn squash_conflict_is_never_reported_as_a_stash_conflict() {
    let (repo, _main_head, feature_tip) = build_conflicting_repo("squash_not_stash");
    let path = repo.path();

    let squashed = merge_squash(path.clone(), feature_tip);
    assert_eq!(squashed.state, "conflict");

    let status = conflict_status(path).expect("conflict_status failed");
    assert_eq!(status.op, "merge-squash");
    assert_ne!(status.op, "stash");
}

#[test]
fn stash_conflict_is_never_reported_as_a_merge_squash_conflict_in_isolation() {
    use gitcat_lib::workdir::{stash_apply, stash_save};

    let repo = TempRepo::init("stash_not_squash");
    let _c0 = repo.commit("f.txt", "base\n", "c0");
    let path = repo.path();

    std::fs::write(repo.dir.join("f.txt"), "stashed change\n").unwrap();
    let saved = stash_save(path.clone(), None, Some(false));
    assert!(saved.ok, "stash_save failed: {}", saved.message);
    let _c1 = repo.commit("f.txt", "conflicting commit\n", "c1");

    let applied = stash_apply(path.clone(), 0, None);
    assert!(!applied.ok, "expected a conflict");
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    // No squash sidecar exists at all in this repo — a fresh stash conflict
    // must still be recognized as "stash", not misattributed to squash.
    let status = conflict_status(path).expect("conflict_status failed");
    assert_eq!(status.op, "stash");
    assert_ne!(status.op, "merge-squash");
}

/// Regression test for a real, serious bug an adversarial review found: a
/// squash-merge conflict resolved OUT OF BAND (staged + committed directly
/// via the git CLI, bypassing `merge_squash_continue`) left the squash
/// sidecar file on disk. `conflict.rs::detect_op` checks the squash sidecar
/// BEFORE falling back to "stash", so a LATER, wholly unrelated stash
/// conflict on the same repo was misattributed to `"merge-squash"` — and a
/// user clicking Abort would have called `merge_squash_abort`, which reads
/// the STALE sidecar's long-outdated `backup_ref` and hard-resets HEAD to
/// it, silently discarding any real commits made since the squash conflict
/// was resolved. Fixed by having `apply_or_pop`/`merge_squash` each clear
/// BOTH sidecars the moment they confirm `unmerged_files()` is empty at
/// their own start (proof that any prior conflict is genuinely concluded).
#[test]
fn stale_merge_squash_sidecar_does_not_hijack_a_later_unrelated_stash_conflict() {
    use gitcat_lib::workdir::{stash_apply, stash_save};

    let (repo, _main_head, feature_tip) = build_conflicting_repo("stale_squash_sidecar");
    let path = repo.path();

    // 1. A real squash conflict happens; sidecar is written.
    let squashed = merge_squash(path.clone(), feature_tip);
    assert_eq!(squashed.state, "conflict", "expected a conflict, got: {}", squashed.message);
    let squash_sidecar = repo.dir.join(".git").join("gitgui").join("merge-squash-conflict.json");
    assert!(squash_sidecar.exists(), "sidecar should exist right after the conflict");

    // 2. Resolved OUT OF BAND: stage the conflict and commit directly via the
    // CLI, never calling merge_squash_continue — so the sidecar is never
    // cleared by this app's own code, exactly the scenario the doc comment
    // warns about.
    repo.must(&["add", "-A"]);
    repo.must(&["commit", "-q", "--no-verify", "-m", "resolved out of band"]);
    assert!(repo.is_clean());
    assert_eq!(repo.open().state(), RepositoryState::Clean);
    assert!(squash_sidecar.exists(), "sidecar is left stale by an out-of-band resolution — this is the setup, not the bug");

    // 3. A wholly unrelated, LATER stash conflict occurs on the same repo.
    std::fs::write(repo.dir.join("shared.txt"), "stashed change\n").unwrap();
    let saved = stash_save(path.clone(), None, Some(false));
    assert!(saved.ok, "stash_save failed: {}", saved.message);
    repo.commit("shared.txt", "conflicting commit\n", "c-conflicts-with-stash");

    let applied = stash_apply(path.clone(), 0, None);
    assert!(!applied.ok, "expected a real stash conflict");
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    // THE BUG: without the fix, this would report "merge-squash" (the stale
    // sidecar) instead of "stash" — and the stale sidecar would already have
    // been cleared by stash_apply's own start, so it wouldn't even be found
    // here even if detect_op still checked for it.
    assert!(!squash_sidecar.exists(), "apply_or_pop must clear a stale squash sidecar at its own start");
    let status = conflict_status(path).expect("conflict_status failed");
    assert_eq!(status.op, "stash", "a stale squash sidecar must never hijack a genuinely new, unrelated stash conflict");
}

#[test]
fn detect_op_prefers_merge_squash_when_both_sidecars_are_present() {
    // Pathological case per conflict.rs::detect_op's own doc comment: a real
    // squash conflict PLUS a stale/out-of-band stash-conflict sidecar both
    // present at once. Squash must win deterministically (documenting the
    // priority order, not just relying on it).
    let (repo, _main_head, feature_tip) = build_conflicting_repo("squash_stash_priority");
    let path = repo.path();

    let squashed = merge_squash(path.clone(), feature_tip);
    assert_eq!(squashed.state, "conflict");

    // Manually drop a stash-conflict sidecar alongside the real squash one,
    // simulating the out-of-band scenario the doc comment describes (e.g. a
    // `git stash pop` run from a terminal, or a stale leftover file).
    let stash_sidecar = repo.dir.join(".git").join("gitgui").join("stash-conflict.json");
    std::fs::write(
        &stash_sidecar,
        r#"{"backup_ref":"refs/gitgui/backup/does-not-matter","pop":false,"index":0,"stash_sha":"deadbeef"}"#,
    )
    .expect("write fake stash sidecar");

    let status = conflict_status(path.clone()).expect("conflict_status failed");
    assert_eq!(status.op, "merge-squash", "squash must win when both sidecars are present");

    // Cleanup via the SQUASH side's own Abort still works fine afterward.
    let aborted = merge_squash_abort(path);
    assert!(aborted.ok, "merge_squash_abort failed: {}", aborted.message);
}

// ---------------------------------------------------------------------------
// Hunk-level conflict editor (conflict_file_hunks / resolve_conflict_hunks) —
// the in-app resolution editor, additive to the whole-file
// resolve_conflict_file path exercised above.
// ---------------------------------------------------------------------------

/// Like build_conflicting_repo, but the conflicting line sits in the MIDDLE
/// of a multi-line file with real shared context on both sides — so a test
/// can actually prove context/conflict region SPLITTING works, not just that
/// a single-line file round-trips.
fn build_multiline_conflicting_repo(tag: &str) -> (TempRepo, String) {
    let repo = TempRepo::init(tag);
    let _base = repo.commit("shared.txt", "line1\nline2\nline3\n", "base");
    repo.must(&["branch", "feature"]);

    let _main_edit = repo.commit("shared.txt", "line1\nmain-edit\nline3\n", "edit on main");

    repo.must(&["checkout", "-q", "feature"]);
    let feature_tip = repo.commit("shared.txt", "line1\nfeature-edit\nline3\n", "edit on feature");

    repo.must(&["checkout", "-q", "main"]);
    (repo, feature_tip)
}

#[test]
fn conflict_file_hunks_splits_context_from_the_conflicting_region() {
    let (repo, feature_tip) = build_multiline_conflicting_repo("hunks_split");
    let path = repo.path();

    let merged = merge_start(path.clone(), feature_tip, None);
    assert_eq!(merged.state, "conflict", "expected a conflict, got: {}", merged.message);

    let result = conflict_file_hunks(path, "shared.txt".into()).expect("conflict_file_hunks failed");
    assert_eq!(result.path, "shared.txt");
    assert!(!result.binary);
    assert!(result.hunks.len() >= 3, "expected at least [context, conflict, context], got {} hunks", result.hunks.len());

    let conflict_hunks: Vec<_> = result.hunks.iter().filter(|h| h.kind == "conflict").collect();
    assert_eq!(conflict_hunks.len(), 1, "the single-line edit should produce exactly one conflict region");
    let c = conflict_hunks[0];
    assert_eq!(c.ours.as_deref(), Some("main-edit\n"));
    assert_eq!(c.base.as_deref(), Some("line2\n"));
    assert_eq!(c.theirs.as_deref(), Some("feature-edit\n"));

    // The surrounding shared lines must show up as plain, unconflicted context.
    let context_text: String = result.hunks.iter().filter(|h| h.kind == "context").filter_map(|h| h.context.clone()).collect();
    assert!(context_text.contains("line1"), "context should include the line before the conflict");
    assert!(context_text.contains("line3"), "context should include the line after the conflict");
}

#[test]
fn conflict_file_hunks_errors_cleanly_for_a_file_that_is_not_conflicted() {
    let repo = TempRepo::init("hunks_not_conflicted");
    let _base = repo.commit("clean.txt", "nothing wrong here\n", "base");
    let path = repo.path();

    let result = conflict_file_hunks(path, "clean.txt".into());
    assert!(result.is_err(), "a non-conflicted file must be a clean Err, not a panic or a bogus empty result");
}

#[test]
fn conflict_file_hunks_reports_binary_and_no_hunks_for_a_binary_conflict() {
    let repo = TempRepo::init("hunks_binary");
    std::fs::write(repo.dir.join("bin.dat"), [0u8, 1, 2, 3, 0, 255, 254, 0]).expect("write base binary");
    repo.must(&["add", "bin.dat"]);
    repo.must(&["commit", "-q", "-m", "base binary"]);
    repo.must(&["branch", "feature"]);

    std::fs::write(repo.dir.join("bin.dat"), [9u8, 8, 7, 0, 6, 5, 4, 0]).expect("write main binary edit");
    repo.must(&["add", "bin.dat"]);
    repo.must(&["commit", "-q", "-m", "main binary edit"]);

    repo.must(&["checkout", "-q", "feature"]);
    std::fs::write(repo.dir.join("bin.dat"), [1u8, 1, 1, 0, 2, 2, 2, 0]).expect("write feature binary edit");
    repo.must(&["add", "bin.dat"]);
    repo.must(&["commit", "-q", "-m", "feature binary edit"]);
    let feature_tip = repo.rev("HEAD").expect("feature tip sha");
    repo.must(&["checkout", "-q", "main"]);

    let path = repo.path();
    let merged = merge_start(path.clone(), feature_tip, None);
    assert_eq!(merged.state, "conflict", "expected a conflict, got: {}", merged.message);

    let result = conflict_file_hunks(path, "bin.dat".into()).expect("conflict_file_hunks failed");
    assert!(result.binary, "a binary conflict must be reported as binary");
    assert!(result.hunks.is_empty(), "no hunks should be produced for a binary conflict");
}

#[test]
fn resolve_conflict_hunks_writes_stages_and_lets_merge_continue_succeed() {
    let (repo, feature_tip) = build_multiline_conflicting_repo("hunks_resolve");
    let path = repo.path();

    let merged = merge_start(path.clone(), feature_tip, None);
    assert_eq!(merged.state, "conflict", "expected a conflict, got: {}", merged.message);

    // Simulate the frontend joining its hunk choices (here: a hand-edited
    // resolution that's neither pure ours nor pure theirs, proving this path
    // truly accepts free-form text, not just one whole side) into one string.
    let resolved_text = "line1\nboth-considered-edit\nline3\n";
    let resolved = resolve_conflict_hunks(path.clone(), "shared.txt".into(), resolved_text.into());
    assert!(resolved.ok, "resolve_conflict_hunks failed: {}", resolved.message);
    assert_eq!(resolved.remaining, 0);
    assert_eq!(repo.read("shared.txt"), resolved_text);

    let cont = merge_continue(path.clone());
    assert!(cont.ok, "merge_continue failed: {}", cont.message);
    assert_eq!(cont.state, "clean");
    assert_eq!(repo.read("shared.txt"), resolved_text, "the freely-edited resolution must survive the concluding commit");
}

#[test]
fn resolve_conflict_hunks_refuses_outside_a_recognized_conflict_op() {
    let repo = TempRepo::init("hunks_refuse_no_op");
    let _base = repo.commit("f.txt", "base\n", "base");
    let path = repo.path();

    let result = resolve_conflict_hunks(path, "f.txt".into(), "whatever\n".into());
    assert!(!result.ok, "must refuse when there's no recognized conflict operation in progress");
}

// ---------------------------------------------------------------------------
// Multi-branch merge (octopus + sequential) — merge_start_multi /
// merge_queue_continue / merge_queue_abort / merge_queue_status.
// ---------------------------------------------------------------------------

/// Two branches off a common base that both edit `shared.txt`'s ONLY line
/// differently — the simplest possible octopus conflict setup (see
/// `merge_start_multi`'s own doc comment: with HEAD untouched since the base,
/// this is the "conflict on the last sha" shape — the ordinary, resolvable-
/// looking one — but this module treats it identically to the other shape
/// either way, so which one a test happens to construct doesn't matter).
fn build_octopus_conflicting_repo(tag: &str) -> (TempRepo, String, String, String) {
    let repo = TempRepo::init(tag);
    let head_before = repo.commit("shared.txt", "base line\n", "base");
    repo.must(&["branch", "branchB"]);
    repo.must(&["branch", "branchC"]);

    repo.must(&["checkout", "-q", "branchB"]);
    let tip_b = repo.commit("shared.txt", "B edit\n", "B edits shared.txt");

    repo.must(&["checkout", "-q", "branchC"]);
    let tip_c = repo.commit("shared.txt", "C edit\n", "C edits shared.txt (conflicts with B)");

    repo.must(&["checkout", "-q", "main"]);
    (repo, head_before, tip_b, tip_c)
}

/// A sequential-mode setup where the FIRST branch (`tip_a`) genuinely
/// conflicts with main's own prior edit, and the SECOND (`tip_b`) touches an
/// unrelated file so it always merges cleanly once it's the queue's turn.
fn build_sequential_repo(tag: &str) -> (TempRepo, String, String, String) {
    let repo = TempRepo::init(tag);
    let _base = repo.commit("shared.txt", "base line\n", "base");
    repo.must(&["branch", "branchA"]);
    repo.must(&["branch", "branchB"]);

    let main_head = repo.commit("shared.txt", "main edit\n", "main edits shared.txt");

    repo.must(&["checkout", "-q", "branchA"]);
    let tip_a = repo.commit("shared.txt", "A edit\n", "A edits shared.txt (conflicts with main)");

    repo.must(&["checkout", "-q", "branchB"]);
    let tip_b = repo.commit("other.txt", "b content\n", "B adds other.txt (no conflict)");

    repo.must(&["checkout", "-q", "main"]);
    (repo, main_head, tip_a, tip_b)
}

#[test]
fn merge_start_multi_octopus_clean_creates_one_commit_with_every_branch_as_a_parent() {
    let repo = TempRepo::init("octopus_clean");
    let _base = repo.commit("f.txt", "base\n", "base");
    repo.must(&["branch", "branchB"]);
    repo.must(&["branch", "branchC"]);
    repo.must(&["branch", "branchD"]);

    repo.must(&["checkout", "-q", "branchB"]);
    let tip_b = repo.commit("b.txt", "b content\n", "B adds b.txt");

    repo.must(&["checkout", "-q", "branchC"]);
    let tip_c = repo.commit("c.txt", "c content\n", "C adds c.txt");

    repo.must(&["checkout", "-q", "branchD"]);
    let tip_d = repo.commit("d.txt", "d content\n", "D adds d.txt");

    repo.must(&["checkout", "-q", "main"]);
    let path = repo.path();

    let result = merge_start_multi(path.clone(), vec![tip_b, tip_c, tip_d], "octopus".into(), None);
    assert!(result.ok, "expected a clean octopus merge, got: {}", result.message);
    assert_eq!(result.state, "clean");
    assert!(result.backup_ref.is_some(), "merge_start_multi should snapshot before mutating");

    let git2repo = repo.open();
    let head = git2repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 3, "octopus of 3 non-HEAD branches (HEAD unmoved since their common base) should yield a 3-parent merge commit");
    assert_eq!(repo.read("b.txt"), "b content\n");
    assert_eq!(repo.read("c.txt"), "c content\n");
    assert_eq!(repo.read("d.txt"), "d content\n");
    assert_eq!(repo.open().state(), RepositoryState::Clean);
}

#[test]
fn merge_start_multi_octopus_conflict_aborts_outright_and_reports_a_distinct_state() {
    let (repo, head_before, tip_b, tip_c) = build_octopus_conflicting_repo("octopus_conflict");
    let path = repo.path();

    let result = merge_start_multi(path.clone(), vec![tip_b, tip_c], "octopus".into(), None);
    assert!(!result.ok);
    assert_eq!(
        result.state, "octopus-conflict-unsupported",
        "expected the distinct octopus-conflict state, got: {}", result.message
    );
    assert!(
        result.message.to_lowercase().contains("sequential"),
        "message should point at retrying as Sequential: {}", result.message
    );
    assert!(result.backup_ref.is_some(), "should still snapshot before attempting the octopus merge");

    // The whole point of aborting outright: nothing left mutated.
    assert_eq!(repo.rev("HEAD").as_deref(), Some(head_before.as_str()));
    assert_eq!(repo.open().state(), RepositoryState::Clean);
    assert!(repo.is_clean());
    assert_eq!(repo.read("shared.txt"), "base line\n");
}

#[test]
fn merge_start_multi_rejects_fewer_than_two_shas() {
    let repo = TempRepo::init("multi_needs_two");
    let head = repo.commit("f.txt", "base\n", "base");
    let path = repo.path();

    let one = merge_start_multi(path.clone(), vec![head], "octopus".into(), None);
    assert!(!one.ok);
    assert_eq!(one.state, "error");
    assert!(one.message.contains("at least two"), "message: {}", one.message);
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    let none = merge_start_multi(path, vec![], "sequential".into(), None);
    assert!(!none.ok);
    assert!(none.message.contains("at least two"), "message: {}", none.message);
}

#[test]
fn merge_start_multi_rejects_an_unknown_mode() {
    let repo = TempRepo::init("multi_unknown_mode");
    let head = repo.commit("f.txt", "base\n", "base");
    let path = repo.path();

    let result = merge_start_multi(path, vec![head.clone(), head], "bogus".into(), None);
    assert!(!result.ok);
    assert_eq!(result.state, "error");
    assert!(result.message.contains("Unknown merge mode"), "message: {}", result.message);
}

#[test]
fn merge_start_multi_sequential_first_step_conflict_is_resolved_via_the_normal_flow_then_queue_advances() {
    let (repo, _main_head, tip_a, tip_b) = build_sequential_repo("seq_first_conflict");
    let path = repo.path();

    let started = merge_start_multi(path.clone(), vec![tip_a.clone(), tip_b.clone()], "sequential".into(), None);
    assert_eq!(started.state, "conflict", "expected the first step to conflict, got: {}", started.message);
    assert_eq!(started.conflicted_files, vec!["shared.txt".to_string()]);
    assert_eq!(repo.open().state(), RepositoryState::Merge);

    let status = merge_queue_status(path.clone());
    assert!(status.in_progress);
    assert_eq!(status.current.as_deref(), Some(tip_a.as_str()));
    assert_eq!(status.remaining, vec![tip_b.clone()]);
    assert!(status.done.is_empty());

    // Resolve the first step through the ORDINARY, queue-unaware flow — the
    // whole point of reusing merge_continue unchanged.
    let resolved = resolve_conflict_file(path.clone(), "shared.txt".into(), "theirs".into());
    assert!(resolved.ok, "resolve_conflict_file failed: {}", resolved.message);
    let cont = merge_continue(path.clone());
    assert!(cont.ok, "merge_continue failed: {}", cont.message);
    assert_eq!(cont.state, "clean");

    // The sidecar doesn't know the first step finished until merge_queue_continue runs.
    let mid_status = merge_queue_status(path.clone());
    assert!(mid_status.in_progress, "sidecar should still show the queue in progress until continue is called");

    let advanced = merge_queue_continue(path.clone());
    assert!(advanced.ok, "merge_queue_continue failed: {}", advanced.message);
    assert_eq!(advanced.state, "clean", "second step (no conflict) should merge cleanly");

    let final_status = merge_queue_status(path.clone());
    assert!(!final_status.in_progress, "queue should be fully finished");
    assert!(final_status.remaining.is_empty());

    assert_eq!(repo.read("shared.txt"), "A edit\n", "\"theirs\" (branchA) should have been kept");
    assert_eq!(repo.read("other.txt"), "b content\n", "second step's file should be present");
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    // History: TWO separate 2-parent merge commits (a sequential queue, not one octopus commit).
    let git2repo = repo.open();
    let head = git2repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head.parent_count(), 2);
    let first_parent = head.parent(0).unwrap();
    assert_eq!(first_parent.parent_count(), 2, "the first step's own merge commit should also have 2 parents");
}

#[test]
fn merge_queue_continue_advances_through_a_fully_clean_sequential_queue() {
    let repo = TempRepo::init("seq_all_clean");
    let _base = repo.commit("f.txt", "base\n", "base");
    repo.must(&["branch", "branchB"]);
    repo.must(&["branch", "branchC"]);

    repo.must(&["checkout", "-q", "branchB"]);
    let tip_b = repo.commit("b.txt", "b content\n", "B adds b.txt");

    repo.must(&["checkout", "-q", "branchC"]);
    let tip_c = repo.commit("c.txt", "c content\n", "C adds c.txt");

    repo.must(&["checkout", "-q", "main"]);
    let path = repo.path();

    let started = merge_start_multi(path.clone(), vec![tip_b, tip_c], "sequential".into(), None);
    assert!(started.ok, "expected the first step to merge cleanly, got: {}", started.message);
    assert_eq!(started.state, "clean");

    let status = merge_queue_status(path.clone());
    assert!(status.in_progress, "one branch is still queued");
    assert_eq!(status.remaining.len(), 1);
    assert_eq!(status.done.len(), 1);

    let advanced = merge_queue_continue(path.clone());
    assert!(advanced.ok, "merge_queue_continue failed: {}", advanced.message);
    assert_eq!(advanced.state, "clean");

    let final_status = merge_queue_status(path.clone());
    assert!(!final_status.in_progress, "queue should be fully finished");

    assert_eq!(repo.read("b.txt"), "b content\n");
    assert_eq!(repo.read("c.txt"), "c content\n");
}

#[test]
fn merge_start_multi_sequential_applies_the_chosen_strategy_to_every_step() {
    let repo = TempRepo::init("seq_no_ff");
    let _base = repo.commit("f.txt", "base\n", "base");
    repo.must(&["branch", "branchB"]);
    repo.must(&["branch", "branchC"]);

    repo.must(&["checkout", "-q", "branchB"]);
    let tip_b = repo.commit("b.txt", "b content\n", "B adds b.txt");

    repo.must(&["checkout", "-q", "branchC"]);
    let tip_c = repo.commit("c.txt", "c content\n", "C adds c.txt");

    repo.must(&["checkout", "-q", "main"]);
    let path = repo.path();

    let started = merge_start_multi(path.clone(), vec![tip_b, tip_c], "sequential".into(), Some("no-ff".into()));
    assert!(started.ok, "expected a clean merge, got: {}", started.message);
    // --no-ff must force a real merge commit for EVERY step, even though
    // branchB's own merge into main would otherwise fast-forward cleanly
    // (main is its own direct ancestor here).
    let git2repo = repo.open();
    let head_after_first = git2repo.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head_after_first.parent_count(), 2, "first step should be a real merge commit under --no-ff, not a fast-forward");

    let advanced = merge_queue_continue(path.clone());
    assert!(advanced.ok, "merge_queue_continue failed: {}", advanced.message);
    let git2repo2 = repo.open();
    let head_after_second = git2repo2.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(head_after_second.parent_count(), 2, "second step should ALSO be a real --no-ff merge commit, using the strategy captured at queue start");
}

#[test]
fn merge_queue_continue_refuses_while_the_current_step_is_still_conflicted() {
    let (repo, _main_head, tip_a, tip_b) = build_sequential_repo("seq_refuse_mid_conflict");
    let path = repo.path();

    let started = merge_start_multi(path.clone(), vec![tip_a, tip_b], "sequential".into(), None);
    assert_eq!(started.state, "conflict");

    // Calling continue BEFORE resolving anything must refuse, not silently
    // skip ahead or corrupt the queue.
    let advanced = merge_queue_continue(path.clone());
    assert!(!advanced.ok);
    assert_eq!(advanced.state, "error");
    assert!(advanced.message.contains("Finish resolving"), "message: {}", advanced.message);

    // The sidecar must still be intact — abort still works after a refused continue.
    let aborted = merge_queue_abort(path);
    assert!(aborted.ok, "merge_queue_abort failed: {}", aborted.message);
}

#[test]
fn merge_queue_abort_cancels_remaining_branches_but_keeps_already_merged_steps() {
    let repo = TempRepo::init("seq_abort_partial");
    let _base1 = repo.commit("f.txt", "base\n", "base f");
    let _base2 = repo.commit("shared.txt", "shared base\n", "base shared");
    repo.must(&["branch", "branchB"]);
    repo.must(&["branch", "branchC"]);

    repo.must(&["checkout", "-q", "branchB"]);
    let tip_b = repo.commit("b.txt", "b content\n", "B adds b.txt");

    repo.must(&["checkout", "-q", "branchC"]);
    let tip_c = repo.commit("shared.txt", "C edit\n", "C edits shared.txt");

    repo.must(&["checkout", "-q", "main"]);
    repo.commit("shared.txt", "main edit\n", "main edits shared.txt (will conflict with C later)");
    let path = repo.path();

    let started = merge_start_multi(path.clone(), vec![tip_b, tip_c], "sequential".into(), None);
    assert!(started.ok, "expected the first step (B) to merge cleanly, got: {}", started.message);
    assert_eq!(started.state, "clean");
    assert_eq!(repo.read("b.txt"), "b content\n", "B's own change must already be committed");

    let advanced = merge_queue_continue(path.clone());
    assert_eq!(advanced.state, "conflict", "expected the second step (C) to conflict with main's own edit, got: {}", advanced.message);
    assert_eq!(repo.open().state(), RepositoryState::Merge);

    let aborted = merge_queue_abort(path.clone());
    assert!(aborted.ok, "merge_queue_abort failed: {}", aborted.message);
    assert_eq!(aborted.state, "clean");
    assert_eq!(repo.open().state(), RepositoryState::Clean, "the live conflict on C must be aborted");
    assert_eq!(repo.read("b.txt"), "b content\n", "B's already-merged commit must be kept, not rolled back");
    assert_eq!(repo.read("shared.txt"), "main edit\n", "C's conflicting change must be reverted by the abort");

    let status = merge_queue_status(path.clone());
    assert!(!status.in_progress, "sidecar must be cleared once aborted");

    // Idempotent: a second abort with nothing outstanding is a benign no-op.
    let again = merge_queue_abort(path);
    assert!(again.ok);
    assert_eq!(again.state, "clean");
}

#[test]
fn merge_start_multi_refuses_to_stack_on_an_existing_merge_or_queue() {
    let (repo, _main_head, tip_a, tip_b) = build_sequential_repo("multi_refuses_stacking");
    let path = repo.path();

    let started = merge_start_multi(path.clone(), vec![tip_a.clone(), tip_b.clone()], "sequential".into(), None);
    assert_eq!(started.state, "conflict");

    // A live merge conflict (MERGE_HEAD present) must refuse a fresh multi-merge outright.
    let blocked = merge_start_multi(path.clone(), vec![tip_a.clone(), tip_b.clone()], "octopus".into(), None);
    assert!(!blocked.ok);
    assert_eq!(blocked.state, "error");
    assert!(blocked.message.contains("already in progress"), "message: {}", blocked.message);

    // Resolve + finish the current step, but the queue's second branch is
    // still queued — the sidecar itself (not just MERGE_HEAD) must also gate
    // a fresh multi-merge.
    let resolved = resolve_conflict_file(path.clone(), "shared.txt".into(), "theirs".into());
    assert!(resolved.ok, "resolve_conflict_file failed: {}", resolved.message);
    let cont = merge_continue(path.clone());
    assert!(cont.ok, "merge_continue failed: {}", cont.message);
    assert_eq!(cont.state, "clean");

    let blocked2 = merge_start_multi(path, vec![tip_a, tip_b], "octopus".into(), None);
    assert!(!blocked2.ok);
    assert_eq!(blocked2.state, "error");
    assert!(blocked2.message.contains("sequential merge queue"), "message: {}", blocked2.message);
}

// ---------------------------------------------------------------------------
// Regression tests for bugs an adversarial code review found in this feature
// (see the code-review skill's own report) — each of these failed before its
// matching fix.
// ---------------------------------------------------------------------------

/// Regression test for a real, serious bug an adversarial review found:
/// conflict_file_hunks used to feed `git merge-file` with `stage_text` — a
/// DISPLAY-ONLY helper (built for conflict_status's read-only 3-column view)
/// that caps each side at 400 lines and appends a fabricated truncation
/// marker line. resolve_conflict_hunks then wrote that truncated+corrupted
/// text straight back to the working-tree file. Fixed by `stage_full_text`,
/// which never truncates. This test conflicts a file with 450 lines per
/// side — comfortably past the old 400-line cap — with the conflicting
/// region itself sitting past line 400, and proves the full content round-trips.
#[test]
fn conflict_file_hunks_and_resolve_hunks_never_truncate_a_file_past_the_old_400_line_display_cap() {
    let repo = TempRepo::init("hunks_no_truncate");
    let mut base_lines = String::new();
    for i in 0..450 {
        base_lines.push_str(&format!("line{i}\n"));
    }
    let _base = repo.commit("shared.txt", &base_lines, "base (450 lines)");
    repo.must(&["branch", "feature"]);

    let mut main_lines = base_lines.clone();
    main_lines = main_lines.replace("line440\n", "main-edit\n");
    let _main_edit = repo.commit("shared.txt", &main_lines, "edit on main past line 400");

    repo.must(&["checkout", "-q", "feature"]);
    let mut feature_lines = base_lines.clone();
    feature_lines = feature_lines.replace("line440\n", "feature-edit\n");
    let feature_tip = repo.commit("shared.txt", &feature_lines, "edit on feature past line 400");

    repo.must(&["checkout", "-q", "main"]);
    let path = repo.path();

    let merged = merge_start(path.clone(), feature_tip, None);
    assert_eq!(merged.state, "conflict", "expected a conflict, got: {}", merged.message);

    let result = conflict_file_hunks(path.clone(), "shared.txt".into()).expect("conflict_file_hunks failed");
    assert!(!result.binary);
    let full_context: String = result.hunks.iter().filter(|h| h.kind == "context").filter_map(|h| h.context.clone()).collect();
    assert!(!full_context.contains("truncated"), "no truncation marker should ever appear: {full_context}");
    assert!(full_context.contains("line449"), "content past the old 400-line cap must survive: {full_context}");
    assert!(full_context.contains("line0"), "content before the conflict must also survive");

    let conflict_hunks: Vec<_> = result.hunks.iter().filter(|h| h.kind == "conflict").collect();
    assert_eq!(conflict_hunks.len(), 1);
    assert_eq!(conflict_hunks[0].ours.as_deref(), Some("main-edit\n"));
    assert_eq!(conflict_hunks[0].theirs.as_deref(), Some("feature-edit\n"));

    // Resolve with a hand-edit and prove the FULL file (450 lines) survives
    // resolve_conflict_hunks's own write, not just conflict_file_hunks's read.
    let resolved_text = main_lines.replace("main-edit\n", "both-considered-edit\n");
    let resolved = resolve_conflict_hunks(path.clone(), "shared.txt".into(), resolved_text.clone());
    assert!(resolved.ok, "resolve_conflict_hunks failed: {}", resolved.message);
    assert_eq!(repo.read("shared.txt"), resolved_text);
    assert!(repo.read("shared.txt").contains("line449"), "the saved file must still contain lines past the old cap");

    let cont = merge_continue(path.clone());
    assert!(cont.ok, "merge_continue failed: {}", cont.message);
    assert_eq!(repo.read("shared.txt").lines().count(), 450, "no lines should have been lost");
}

/// Regression test for a real bug an adversarial review found: `parse_diff3_hunks`
/// reset its state machine on ANY line matching "<<<<<<< ours", even mid-hunk,
/// silently discarding whatever text had already accumulated. Here the common
/// ANCESTOR's own line literally reads "<<<<<<< ours" — EMPIRICALLY VERIFIED
/// (via a standalone `git merge-file --diff3` repro) that this text surfaces
/// inside the `||||||| base` region of the real output, i.e. while the parser
/// is in state Base, not Context — proving the fix's state guard (not just
/// its presence) matters.
#[test]
fn conflict_file_hunks_preserves_content_that_looks_like_a_conflict_marker() {
    let repo = TempRepo::init("hunks_marker_lookalike");
    let _base = repo.commit("shared.txt", "line1\n<<<<<<< ours\nline3\n", "base (ancestor line literally reads a conflict marker)");
    repo.must(&["branch", "feature"]);

    let _main_edit = repo.commit("shared.txt", "line1\nours-edit\nline3\n", "edit on main");

    repo.must(&["checkout", "-q", "feature"]);
    let feature_tip = repo.commit("shared.txt", "line1\ntheirs-edit\nline3\n", "edit on feature");

    repo.must(&["checkout", "-q", "main"]);
    let path = repo.path();

    let merged = merge_start(path.clone(), feature_tip, None);
    assert_eq!(merged.state, "conflict", "expected a conflict, got: {}", merged.message);

    let result = conflict_file_hunks(path, "shared.txt".into()).expect("conflict_file_hunks failed");
    assert!(!result.binary);
    let conflict_hunks: Vec<_> = result.hunks.iter().filter(|h| h.kind == "conflict").collect();
    assert_eq!(conflict_hunks.len(), 1, "expected exactly one conflict region, got {} hunks total", result.hunks.len());
    let c = conflict_hunks[0];
    assert_eq!(c.ours.as_deref(), Some("ours-edit\n"));
    assert_eq!(
        c.base.as_deref(),
        Some("<<<<<<< ours\n"),
        "the ancestor's own literal marker-look-alike line must be preserved as real content, not silently dropped"
    );
    assert_eq!(c.theirs.as_deref(), Some("theirs-edit\n"));
}

/// Regression test for a path-traversal gap an adversarial review found:
/// `validate_path` used to accept an absolute path or a `..`-laden path —
/// harmless for `resolve_conflict_file` (mediated by `git checkout --
/// <file>`, which git itself confines to the work tree as a pathspec) but a
/// real arbitrary-write risk for `resolve_conflict_hunks`, which writes via
/// plain `std::fs::write` with no such confinement.
#[test]
fn resolve_conflict_hunks_refuses_an_absolute_or_parent_escaping_path() {
    let (repo, _main_head, feature_tip) = build_conflicting_repo("hunks_path_traversal");
    let path = repo.path();
    let merged = merge_start(path.clone(), feature_tip, None);
    assert_eq!(merged.state, "conflict");

    let outside = std::env::temp_dir().join("gitcat-path-traversal-should-never-be-written.txt");
    let _ = std::fs::remove_file(&outside);

    let absolute = resolve_conflict_hunks(path.clone(), outside.to_string_lossy().into_owned(), "pwned\n".into());
    assert!(!absolute.ok, "an absolute path must be refused");
    assert!(!outside.exists(), "nothing must be written outside the repo");

    let traversal = resolve_conflict_hunks(path, "../escaped.txt".into(), "pwned\n".into());
    assert!(!traversal.ok, "a \"..\"-laden path must be refused");
}

/// Regression test for a real, serious bug an adversarial review found:
/// `merge_queue_continue`'s only signal that "the current step is finished"
/// was that the repo looks clean (no MERGE_HEAD, no unmerged files) — but
/// that's equally true when the current step was ABORTED via the plain
/// Resolver "Abort merge" button (not `merge_queue_abort`, the only thing
/// that clears the sidecar). The old code silently promoted the aborted
/// branch into `done` and skipped ahead. Fixed via a HEAD-sha comparison:
/// since HEAD never moves on an abort, `current` is retried instead.
#[test]
fn merge_queue_continue_does_not_silently_mark_an_aborted_step_as_done() {
    let (repo, _main_head, tip_a, tip_b) = build_sequential_repo("seq_abort_via_plain_button");
    let path = repo.path();

    let started = merge_start_multi(path.clone(), vec![tip_a.clone(), tip_b.clone()], "sequential".into(), None);
    assert_eq!(started.state, "conflict");

    // Abort through the ORDINARY, queue-unaware command — exactly what the
    // Resolver's plain "Abort merge" button calls.
    let aborted = merge_abort(path.clone());
    assert!(aborted.ok, "merge_abort failed: {}", aborted.message);
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    // The sidecar is untouched by the plain abort — merge_queue_status still
    // reports the queue as in progress.
    let status = merge_queue_status(path.clone());
    assert!(status.in_progress);

    // Continuing must NOT silently report tip_a as done and skip to tip_b —
    // it was never actually merged.
    let advanced = merge_queue_continue(path.clone());
    assert_ne!(advanced.state, "clean", "the aborted branch must never be silently reported as merged");
    assert_eq!(
        advanced.state, "conflict",
        "retrying the aborted branch should hit the SAME real conflict again, got: {}",
        advanced.message
    );

    let status_after = merge_queue_status(path.clone());
    assert!(status_after.done.is_empty(), "the aborted branch must not have been recorded as done");
    assert_eq!(status_after.current.as_deref(), Some(tip_a.as_str()), "the queue must still be retrying tip_a, not tip_b");
    assert_eq!(status_after.remaining, vec![tip_b]);

    // Clean up via the real queue-aware abort so the test repo isn't left mid-merge.
    let cancelled = merge_queue_abort(path);
    assert!(cancelled.ok);
}

/// Regression test for the same root bug as above, via a DIFFERENT trigger:
/// the current step's merge attempt errors outright (never creates
/// MERGE_HEAD at all, e.g. an `--ff-only` refusal) rather than conflicting.
/// This also used to be silently promoted into `done`.
#[test]
fn merge_queue_continue_retries_current_after_an_outright_error_instead_of_marking_it_done() {
    let repo = TempRepo::init("seq_error_not_done");
    let _base = repo.commit("f.txt", "base\n", "base");
    repo.must(&["branch", "branchA"]);
    repo.must(&["branch", "branchB"]);

    repo.must(&["checkout", "-q", "branchA"]);
    let tip_a = repo.commit("a.txt", "a content\n", "A adds a.txt");

    repo.must(&["checkout", "-q", "branchB"]);
    let tip_b = repo.commit("b.txt", "b content\n", "B adds b.txt");

    // Advance main past the branch point so branchA can't fast-forward.
    repo.must(&["checkout", "-q", "main"]);
    repo.commit("other.txt", "main-only\n", "main advances (breaks ff for branchA)");
    let path = repo.path();

    let started = merge_start_multi(path.clone(), vec![tip_a.clone(), tip_b.clone()], "sequential".into(), Some("ff-only".into()));
    assert_eq!(started.state, "error", "expected an outright ff-only refusal, got: {}", started.message);
    assert_eq!(repo.open().state(), RepositoryState::Clean, "an error must never leave a real conflict/MERGE_HEAD behind");

    let status = merge_queue_status(path.clone());
    assert!(status.in_progress, "the queue sidecar should still show tip_a as the (never-merged) current step");
    assert_eq!(status.current.as_deref(), Some(tip_a.as_str()));

    let advanced = merge_queue_continue(path.clone());
    assert_eq!(advanced.state, "error", "retrying should hit the SAME ff-only refusal again, got: {}", advanced.message);

    let status_after = merge_queue_status(path.clone());
    assert!(status_after.done.is_empty(), "tip_a must never be recorded as done — it was never actually merged");
    assert_eq!(status_after.current.as_deref(), Some(tip_a.as_str()));

    let cancelled = merge_queue_abort(path);
    assert!(cancelled.ok);
}

/// Regression test for a real bug an adversarial review found: `merge_octopus`
/// treated EVERY non-zero exit as the octopus-strategy limitation, even an
/// ordinary dirty-working-tree refusal that never even attempts a merge —
/// losing `blocked_by_local_changes` and telling the user "try Sequential
/// instead" even though Sequential would refuse identically on its own first
/// step for the exact same reason.
#[test]
fn merge_octopus_reports_a_dirty_tree_refusal_honestly_not_as_unsupported() {
    let repo = TempRepo::init("octopus_dirty_tree");
    let _base = repo.commit("shared.txt", "base line\n", "base");
    repo.must(&["branch", "branchB"]);
    repo.must(&["branch", "branchC"]);

    repo.must(&["checkout", "-q", "branchB"]);
    let tip_b = repo.commit("shared.txt", "B edit\n", "B edits shared.txt");

    repo.must(&["checkout", "-q", "branchC"]);
    let tip_c = repo.commit("other.txt", "c content\n", "C adds other.txt (no conflict)");

    repo.must(&["checkout", "-q", "main"]);
    let path = repo.path();
    // Uncommitted local edit to the exact file branchB's merge would touch.
    std::fs::write(repo.dir.join("shared.txt"), "dirty uncommitted edit\n").expect("write dirty file");

    let result = merge_start_multi(path.clone(), vec![tip_b, tip_c], "octopus".into(), None);
    assert!(!result.ok);
    assert_eq!(result.state, "error", "a dirty-tree refusal must be reported as an ordinary error, not octopus-conflict-unsupported: {}", result.message);
    assert!(result.blocked_by_local_changes, "blocked_by_local_changes must be set, exactly like merge_start's own dirty-tree case: {}", result.message);
    assert_eq!(repo.open().state(), RepositoryState::Clean);
    assert_eq!(repo.read("shared.txt"), "dirty uncommitted edit\n", "the user's uncommitted edit must be left exactly as-is");
}
