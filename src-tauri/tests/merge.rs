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
use gitcat_lib::conflict::{conflict_status, resolve_conflict_file};
use gitcat_lib::git_merge::{
    merge_abort, merge_continue, merge_squash, merge_squash_abort, merge_squash_continue, merge_start,
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
