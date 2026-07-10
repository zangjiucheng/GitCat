//! Working tree: status, stage/unstage, discard, commit, and stash (model
//! after tests/branch_ops.rs / tests/merge.rs). Calls the plain Rust functions
//! directly (bypassing Tauri IPC), on a throwaway `TempRepo`.

mod common;

use common::TempRepo;
use git2::RepositoryState;
use gitcat_lib::conflict::{conflict_status, resolve_conflict_file};
use gitcat_lib::safety::{list_snapshots, undo};
use gitcat_lib::workdir::{
    commit, discard_file, stage_all, stage_file, stash_apply, stash_conflict_abort,
    stash_conflict_continue, stash_drop, stash_list, stash_pop, stash_save, stash_undo_apply,
    unstage_file, workdir_file_diff, workdir_status,
};

#[test]
fn workdir_status_reports_staged_unstaged_and_untracked() {
    let repo = TempRepo::init("workdir_status");
    let _c0 = repo.commit("modified.txt", "0\n", "c0");
    let _c1 = repo.commit("deleted.txt", "0\n", "c1");
    let path = repo.path();

    // Modify a tracked file (unstaged).
    std::fs::write(repo.dir.join("modified.txt"), "1\n").unwrap();
    // Delete a tracked file (unstaged).
    std::fs::remove_file(repo.dir.join("deleted.txt")).unwrap();
    // A new file, staged.
    std::fs::write(repo.dir.join("staged.txt"), "new\n").unwrap();
    repo.must(&["add", "--", "staged.txt"]);
    // A new file, untracked.
    std::fs::write(repo.dir.join("untracked.txt"), "new\n").unwrap();

    let status = workdir_status(path).expect("workdir_status failed");
    assert_eq!(status.conflicted, 0);
    assert!(!status.has_stash);
    assert_eq!(status.branch.as_deref(), Some("main"));

    assert_eq!(status.staged.len(), 1);
    assert_eq!(status.staged[0].path, "staged.txt");
    assert_eq!(status.staged[0].status, "A");

    let mut unstaged_paths: Vec<(&str, &str)> =
        status.unstaged.iter().map(|e| (e.path.as_str(), e.status.as_str())).collect();
    unstaged_paths.sort();
    assert_eq!(
        unstaged_paths,
        vec![("deleted.txt", "D"), ("modified.txt", "M"), ("untracked.txt", "?")]
    );
}

#[test]
fn stage_file_and_unstage_file_round_trip_takes_no_snapshot() {
    let repo = TempRepo::init("workdir_stage_unstage");
    let _c0 = repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();
    std::fs::write(repo.dir.join("f.txt"), "1\n").unwrap();

    let snaps_before = list_snapshots(path.clone()).expect("list_snapshots failed");

    let staged = stage_file(path.clone(), "f.txt".into());
    assert!(staged.ok, "stage_file failed: {}", staged.message);
    assert!(staged.backup_ref.is_none(), "stage_file must not snapshot");

    let status = workdir_status(path.clone()).unwrap();
    assert_eq!(status.staged.len(), 1);
    assert_eq!(status.staged[0].path, "f.txt");
    assert_eq!(status.staged[0].status, "M");
    assert!(status.unstaged.is_empty());

    let unstaged = unstage_file(path.clone(), "f.txt".into());
    assert!(unstaged.ok, "unstage_file failed: {}", unstaged.message);
    assert!(unstaged.backup_ref.is_none(), "unstage_file must not snapshot");

    let status = workdir_status(path.clone()).unwrap();
    assert!(status.staged.is_empty());
    assert_eq!(status.unstaged.len(), 1);
    assert_eq!(status.unstaged[0].path, "f.txt");

    // Regression test for the "no snapshot flood" policy: the snapshot count
    // must be UNCHANGED across both calls.
    let snaps_after = list_snapshots(path).expect("list_snapshots failed");
    assert_eq!(snaps_before.len(), snaps_after.len());
}

#[test]
fn stage_all_stages_every_unstaged_and_untracked_path() {
    let repo = TempRepo::init("workdir_stage_all");
    let _c0 = repo.commit("a.txt", "0\n", "c0");
    let _c1 = repo.commit("b.txt", "0\n", "c1");
    let path = repo.path();

    std::fs::write(repo.dir.join("a.txt"), "1\n").unwrap();
    std::fs::write(repo.dir.join("b.txt"), "1\n").unwrap();
    std::fs::write(repo.dir.join("c.txt"), "new\n").unwrap();

    let res = stage_all(path.clone());
    assert!(res.ok, "stage_all failed: {}", res.message);
    assert!(res.backup_ref.is_none(), "stage_all must not snapshot");

    let status = workdir_status(path).unwrap();
    assert!(status.unstaged.is_empty());
    assert_eq!(status.staged.len(), 3);
}

#[test]
fn discard_file_restores_tracked_content_and_writes_a_patch_backup() {
    let repo = TempRepo::init("workdir_discard_tracked");
    let _c0 = repo.commit("f.txt", "original\n", "c0");
    let path = repo.path();
    std::fs::write(repo.dir.join("f.txt"), "changed\n").unwrap();

    let res = discard_file(path.clone(), "f.txt".into(), false);
    assert!(res.ok, "discard_file failed: {}", res.message);
    assert!(res.backup_ref.is_none(), "discard_file has no ref-level backup");
    let backup_rel = res.backup_patch.clone().expect("expected a backup_patch path");
    assert!(backup_rel.starts_with("gitgui/discard-backup/"), "unexpected backup path: {backup_rel}");
    assert!(backup_rel.ends_with(".patch"));

    let full_path = repo.open().path().join(&backup_rel);
    assert!(full_path.exists(), "backup patch file does not exist at {full_path:?}");
    let patch_contents = std::fs::read_to_string(&full_path).unwrap();
    assert!(patch_contents.contains("-original"), "patch should record the removed line: {patch_contents}");
    assert!(patch_contents.contains("+changed"), "patch should record the added line: {patch_contents}");

    // Working file restored to HEAD's content, and the tree is clean again.
    assert_eq!(repo.read("f.txt"), "original\n");
    assert!(repo.is_clean());
}

#[test]
fn discard_file_untracked_removes_the_file_and_backs_up_its_bytes() {
    let repo = TempRepo::init("workdir_discard_untracked");
    let _c0 = repo.commit("keep.txt", "0\n", "c0");
    let path = repo.path();
    std::fs::write(repo.dir.join("scratch.txt"), "throwaway content\n").unwrap();

    let res = discard_file(path.clone(), "scratch.txt".into(), true);
    assert!(res.ok, "discard_file(untracked) failed: {}", res.message);
    let backup_rel = res.backup_patch.clone().expect("expected a backup_patch path");
    assert!(backup_rel.ends_with(".orig"));

    assert!(!repo.dir.join("scratch.txt").exists(), "untracked file should be removed");

    let full_path = repo.open().path().join(&backup_rel);
    let backed_up = std::fs::read_to_string(&full_path).unwrap();
    assert_eq!(backed_up, "throwaway content\n", "backup bytes should equal the original exactly");
}

#[test]
fn discard_file_untracked_directory_backs_up_the_tree_and_removes_it() {
    // Same shape as an orphaned submodule checkout left behind after a
    // revert/reset removes its gitlink but (same as real git) can't rmdir a
    // populated nested-.git working tree: `git status` reports the whole
    // directory as ONE untracked entry (never recursed into — that boundary
    // is intentional, see backup_untracked_bytes's doc comment), so
    // discard_file must be able to back up and remove a DIRECTORY, not just
    // a single file.
    let repo = TempRepo::init("workdir_discard_untracked_dir");
    let _c0 = repo.commit("keep.txt", "0\n", "c0");
    let path = repo.path();

    let nested = repo.dir.join("nested-repo");
    std::fs::create_dir_all(nested.join("sub")).unwrap();
    std::process::Command::new("git").args(["init", "-q"]).current_dir(&nested).status().unwrap();
    std::fs::write(nested.join("file.txt"), "top-level content\n").unwrap();
    std::fs::write(nested.join("sub/nested.txt"), "nested content\n").unwrap();

    let status = workdir_status(path.clone()).unwrap();
    assert_eq!(status.unstaged.len(), 1, "the nested repo should show as ONE untracked entry");
    let entry_path = status.unstaged[0].path.clone();
    assert_eq!(status.unstaged[0].status, "?");

    let res = discard_file(path.clone(), entry_path, true);
    assert!(res.ok, "discard_file(untracked dir) failed: {}", res.message);
    let backup_rel = res.backup_patch.clone().expect("expected a backup_patch path");
    assert!(backup_rel.ends_with('/'), "a directory backup should itself be a directory: {backup_rel}");

    assert!(!nested.exists(), "the untracked directory should be removed (needs clean -fd, not just -f)");

    let full_backup = repo.open().path().join(backup_rel.trim_end_matches('/'));
    assert_eq!(std::fs::read_to_string(full_backup.join("file.txt")).unwrap(), "top-level content\n");
    assert_eq!(std::fs::read_to_string(full_backup.join("sub/nested.txt")).unwrap(), "nested content\n");
}

#[test]
fn commit_creates_a_real_commit_and_snapshots_first() {
    let repo = TempRepo::init("workdir_commit");
    let c0 = repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();
    std::fs::write(repo.dir.join("f.txt"), "1\n").unwrap();
    repo.must(&["add", "-A"]);

    let res = commit(path.clone(), Some("my commit message".into()), None);
    assert!(res.ok, "commit failed: {}", res.message);
    assert!(res.backup_ref.is_some(), "commit should snapshot first");

    let new_head = repo.rev("HEAD").expect("HEAD should resolve");
    assert_ne!(new_head, c0, "HEAD should have moved");
    assert_eq!(repo.must(&["log", "-1", "--format=%s"]), "my commit message");
    assert_eq!(repo.must(&["rev-parse", "HEAD^"]), c0);
    assert!(repo.is_clean());
}

#[test]
fn commit_amend_without_message_keeps_prior_message_and_rewrites_sha() {
    let repo = TempRepo::init("workdir_commit_amend");
    let _c0 = repo.commit("f.txt", "0\n", "c0");
    let c1 = repo.commit("f.txt", "1\n", "amend me");
    let path = repo.path();

    std::fs::write(repo.dir.join("f.txt"), "2\n").unwrap();
    repo.must(&["add", "-A"]);

    let res = commit(path.clone(), None, Some(true));
    assert!(res.ok, "amend failed: {}", res.message);
    assert!(res.backup_ref.is_some(), "amend should snapshot first");

    let new_head = repo.rev("HEAD").unwrap();
    assert_ne!(new_head, c1, "amend should rewrite HEAD's sha");
    assert_eq!(repo.must(&["log", "-1", "--format=%s"]), "amend me", "amend --no-edit must keep the prior subject");
    assert_eq!(repo.read("f.txt"), "2\n");
}

#[test]
fn commit_refuses_with_empty_message_and_not_amending() {
    let repo = TempRepo::init("workdir_commit_empty_msg");
    let c0 = repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();
    std::fs::write(repo.dir.join("f.txt"), "1\n").unwrap();
    repo.must(&["add", "-A"]);

    let res = commit(path.clone(), Some("   ".into()), None);
    assert!(!res.ok, "commit with an empty message should be refused");
    assert!(res.message.to_lowercase().contains("empty"), "unexpected message: {}", res.message);
    assert!(res.backup_ref.is_none(), "a refused, never-attempted commit must not have snapshotted");
    assert_eq!(repo.rev("HEAD").unwrap(), c0, "HEAD must not have moved");
}

#[test]
fn stash_save_list_apply_pop_drop_full_lifecycle() {
    let repo = TempRepo::init("workdir_stash_lifecycle");
    let _c0 = repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();

    std::fs::write(repo.dir.join("f.txt"), "dirty\n").unwrap();
    assert!(!repo.is_clean());

    let saved = stash_save(path.clone(), Some("my stash".into()), Some(false));
    assert!(saved.ok, "stash_save failed: {}", saved.message);
    assert!(saved.backup_ref.is_some(), "stash_save should snapshot first");
    assert!(repo.is_clean(), "working tree should be clean after stash push");

    let list = stash_list(path.clone()).expect("stash_list failed");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].index, 0);
    assert_eq!(list[0].branch.as_deref(), Some("main"));

    // Apply re-dirties the tree AND keeps the stash entry.
    let applied = stash_apply(path.clone(), 0, None);
    assert!(applied.ok, "stash_apply failed: {}", applied.message);
    assert_eq!(repo.read("f.txt"), "dirty\n");
    let list_after_apply = stash_list(path.clone()).expect("stash_list failed");
    assert_eq!(list_after_apply.len(), 1, "apply must not drop the stash entry");

    // Clean up again for pop.
    repo.must(&["checkout", "--", "f.txt"]);
    assert!(repo.is_clean());

    let popped = stash_pop(path.clone(), 0, None);
    assert!(popped.ok, "stash_pop failed: {}", popped.message);
    assert_eq!(repo.read("f.txt"), "dirty\n");
    let list_after_pop = stash_list(path.clone()).expect("stash_list failed");
    assert!(list_after_pop.is_empty(), "pop should drop the stash entry");

    // One more save + explicit drop.
    let saved2 = stash_save(path.clone(), None, Some(false));
    assert!(saved2.ok, "second stash_save failed: {}", saved2.message);
    let dropped = stash_drop(path.clone(), 0, None);
    assert!(dropped.ok, "stash_drop failed: {}", dropped.message);
    assert!(dropped.backup_ref.is_some(), "stash_drop should snapshot first");

    let list_final = stash_list(path.clone()).expect("stash_list failed");
    assert!(list_final.is_empty());
    // Confirmed independently via the raw CLI.
    assert_eq!(repo.must(&["stash", "list"]), "");
}

#[test]
fn stash_apply_conflict_is_surfaced_and_stash_entry_is_kept() {
    let repo = TempRepo::init("workdir_stash_conflict");
    let _c0 = repo.commit("f.txt", "base\n", "c0");
    let path = repo.path();

    // Stash a change to f.txt.
    std::fs::write(repo.dir.join("f.txt"), "stashed change\n").unwrap();
    let saved = stash_save(path.clone(), None, Some(false));
    assert!(saved.ok, "stash_save failed: {}", saved.message);
    assert!(repo.is_clean());

    // Commit a conflicting edit to the SAME line on top of HEAD.
    let _c1 = repo.commit("f.txt", "conflicting commit\n", "c1");

    let applied = stash_apply(path.clone(), 0, None);
    assert!(!applied.ok, "expected stash_apply to hit a conflict");
    assert_eq!(applied.conflicted_files, vec!["f.txt".to_string()]);
    assert!(applied.backup_ref.is_some(), "stash_apply should have snapshotted before attempting");

    // Nothing lost: the stash entry is still there.
    let list = stash_list(path.clone()).expect("stash_list failed");
    assert_eq!(list.len(), 1, "a failed apply must never drop the stash entry");
}

// ---------------------------------------------------------------------------
// Finding #1: dedicated Undo path for stash_apply/stash_pop (safety::undo()'s
// generic dirty-tree guard can never fire right after either op).
// ---------------------------------------------------------------------------

#[test]
fn global_undo_refuses_after_stash_apply_but_stash_undo_apply_restores_a_clean_tree() {
    let repo = TempRepo::init("workdir_stash_undo_apply");
    let _c0 = repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();

    std::fs::write(repo.dir.join("f.txt"), "dirty\n").unwrap();
    let saved = stash_save(path.clone(), None, Some(false));
    assert!(saved.ok, "stash_save failed: {}", saved.message);
    assert!(repo.is_clean());

    let applied = stash_apply(path.clone(), 0, None);
    assert!(applied.ok, "stash_apply failed: {}", applied.message);
    assert!(!repo.is_clean(), "apply must leave the tree dirty by definition");

    // Reproduces the ORIGINAL bug: safety::undo()'s dirty-tree guard refuses
    // unconditionally, even though nothing at the ref level moved.
    let blocked = undo(&repo.open()).expect("undo should not hard-error");
    assert!(!blocked.ok, "the generic global-undo path must still refuse on a dirty tree");
    assert!(
        blocked.message.to_lowercase().contains("uncommitted"),
        "unexpected refusal message: {}",
        blocked.message
    );

    // The dedicated stash-undo path succeeds instead, restoring a clean tree.
    let undone = stash_undo_apply(path.clone());
    assert!(undone.ok, "stash_undo_apply failed: {}", undone.message);
    assert!(repo.is_clean(), "tree should be clean again after re-stashing");
    assert!(undone.backup_ref.is_some(), "stash_undo_apply should snapshot first");

    // Content is preserved (as a NEW stash entry) — nothing lost.
    let list = stash_list(path.clone()).expect("stash_list failed");
    assert!(!list.is_empty(), "re-stashed content should appear in the stash list");
}

#[test]
fn stash_undo_apply_refuses_on_an_already_clean_tree() {
    let repo = TempRepo::init("workdir_stash_undo_apply_clean");
    let _c0 = repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();
    assert!(repo.is_clean());

    let res = stash_undo_apply(path);
    assert!(!res.ok, "stash_undo_apply on a clean tree should refuse, not push an empty stash");
}

// ---------------------------------------------------------------------------
// Finding #2: stash_drop must back up the dropped stash's own content BEFORE
// dropping it (safety::snapshot only ever tracks refs/heads/*, never
// refs/stash, so the pre-existing "snapshot ref" was never actually
// undo-able for a drop).
// ---------------------------------------------------------------------------

#[test]
fn stash_drop_pins_the_dropped_commit_so_it_survives_gc_and_is_recoverable() {
    let repo = TempRepo::init("workdir_stash_drop_backup");
    let _c0 = repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();

    std::fs::write(repo.dir.join("f.txt"), "dirty\n").unwrap();
    let saved = stash_save(path.clone(), None, Some(false));
    assert!(saved.ok, "stash_save failed: {}", saved.message);

    let stash_sha = repo.must(&["rev-parse", "stash@{0}"]);

    let dropped = stash_drop(path.clone(), 0, None);
    assert!(dropped.ok, "stash_drop failed: {}", dropped.message);
    let pin_ref = dropped.dropped_stash_ref.clone().expect("stash_drop must pin the dropped commit");
    assert!(pin_ref.starts_with("refs/gitgui/"), "unexpected pin ref: {pin_ref}");

    // The stash entry itself is gone from `stash list`...
    let list = stash_list(path.clone()).expect("stash_list failed");
    assert!(list.is_empty());

    // ...but the commit object is still reachable via the pinned ref, and its
    // content is really recoverable (this is the whole point of the fix —
    // NOT just a HEAD ref that happens not to have moved).
    assert_eq!(repo.must(&["rev-parse", &pin_ref]), stash_sha, "pinned ref should point at the dropped stash's own commit");
    assert!(repo.obj_exists(&stash_sha), "dropped stash commit must not be orphaned");

    let (ok, _so, se) = repo.git(&["stash", "apply", &pin_ref]);
    assert!(ok, "recovering via `git stash apply <pin>` should work: {se}");
    assert_eq!(repo.read("f.txt"), "dirty\n", "recovered content should match what was stashed");
}

// ---------------------------------------------------------------------------
// Finding #5: `--` alone does NOT neutralize pathspec glob magic — every
// pathspec must be run through `:(literal)`.
// ---------------------------------------------------------------------------

#[test]
fn stage_file_with_glob_metacharacters_stages_only_the_exact_file() {
    let repo = TempRepo::init("workdir_glob_pathspec");
    let _c0 = repo.commit("keep.txt", "0\n", "c0");
    let path = repo.path();

    // A decoy that the BUGGY behavior (`git add -- 'test[1].txt'` glob-
    // matching, since `--` alone does not disable pathspec magic) would stage
    // instead of the real target.
    std::fs::write(repo.dir.join("test1.txt"), "decoy\n").unwrap();
    std::fs::write(repo.dir.join("test[1].txt"), "real target\n").unwrap();

    let res = stage_file(path.clone(), "test[1].txt".into());
    assert!(res.ok, "stage_file failed: {}", res.message);

    let status = workdir_status(path).unwrap();
    let staged_paths: Vec<&str> = status.staged.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(staged_paths, vec!["test[1].txt"], "must stage exactly the requested file, not a glob-matched decoy");
    assert!(
        status.unstaged.iter().any(|e| e.path == "test1.txt" && e.status == "?"),
        "the decoy must remain untracked, not swept up by glob matching"
    );
}

#[test]
fn discard_file_with_glob_metacharacters_backs_up_and_restores_the_exact_file() {
    let repo = TempRepo::init("workdir_glob_discard");
    let _c0 = repo.commit("test[1].txt", "original\n", "c0");
    let _c1 = repo.commit("test1.txt", "unrelated\n", "c1");
    let path = repo.path();

    // Modify BOTH the glob-metacharacter file and its glob-decoy sibling —
    // `backup_tracked_patch`'s (git2, not CLI) pathspec matching had the same
    // class of bug (libgit2 has no `:(literal)` magic either), which this
    // exercises via `workdir_file_diff` and `discard_file` together.
    std::fs::write(repo.dir.join("test[1].txt"), "changed target\n").unwrap();
    std::fs::write(repo.dir.join("test1.txt"), "changed decoy\n").unwrap();

    let diff = workdir_file_diff(path.clone(), "test[1].txt".into(), false)
        .expect("workdir_file_diff failed");
    assert_eq!(diff.path, "test[1].txt", "diff must resolve to the exact requested file");

    let res = discard_file(path.clone(), "test[1].txt".into(), false);
    assert!(res.ok, "discard_file failed: {}", res.message);
    assert_eq!(repo.read("test[1].txt"), "original\n", "the exact target must be restored");
    assert_eq!(repo.read("test1.txt"), "changed decoy\n", "the decoy sibling must be UNTOUCHED");

    let backup_rel = res.backup_patch.expect("expected a backup_patch path");
    let full_path = repo.open().path().join(&backup_rel);
    let patch_contents = std::fs::read_to_string(&full_path).unwrap();
    assert!(patch_contents.contains("+changed target"), "backup patch must record the TARGET's own change, not the decoy's: {patch_contents}");
}

// ---------------------------------------------------------------------------
// Finding #6: stash_apply/pop/drop take an optional `expected_sha` sanity
// check against a stale positional stash@{N} index.
// ---------------------------------------------------------------------------

#[test]
fn stash_apply_refuses_when_expected_sha_does_not_match_current_stash_at_index() {
    let repo = TempRepo::init("workdir_stash_identity");
    let _c0 = repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();

    std::fs::write(repo.dir.join("f.txt"), "dirty\n").unwrap();
    let saved = stash_save(path.clone(), None, Some(false));
    assert!(saved.ok);
    let list = stash_list(path.clone()).expect("stash_list failed");
    let real_sha = list[0].sha.clone();

    // A stale/forged sha must be refused BEFORE anything is mutated.
    let res = stash_apply(path.clone(), 0, Some("deadbeef".into()));
    assert!(!res.ok, "stash_apply must refuse when expected_sha does not match");
    assert!(res.backup_ref.is_none(), "a refused, never-attempted apply must not have snapshotted");
    assert!(repo.is_clean(), "a refused apply must not have touched the working tree");

    // The CORRECT sha succeeds normally.
    let ok_res = stash_apply(path.clone(), 0, Some(real_sha));
    assert!(ok_res.ok, "stash_apply with the correct expected_sha should succeed: {}", ok_res.message);
}

#[test]
fn stash_drop_refuses_when_expected_sha_does_not_match() {
    let repo = TempRepo::init("workdir_stash_drop_identity");
    let _c0 = repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();

    std::fs::write(repo.dir.join("f.txt"), "dirty\n").unwrap();
    let saved = stash_save(path.clone(), None, Some(false));
    assert!(saved.ok);

    let res = stash_drop(path.clone(), 0, Some("deadbeef".into()));
    assert!(!res.ok, "stash_drop must refuse when expected_sha does not match");
    let list = stash_list(path.clone()).expect("stash_list failed");
    assert_eq!(list.len(), 1, "a refused drop must not have dropped anything");
}

// ---------------------------------------------------------------------------
// Finding #7: a stash-apply/pop conflict is resolvable end to end via the
// same Resolver flow as merge/rebase/cherry-pick (conflict.rs's "stash" op +
// stash_conflict_abort/stash_conflict_continue).
// ---------------------------------------------------------------------------

/// Builds a repo where APPLYING (or popping) `stash@{0}` back onto `main`
/// conflicts: the stash and a later commit both edit the same line. Returns
/// (repo, path).
fn build_stash_conflict_repo(tag: &str) -> (TempRepo, String) {
    let repo = TempRepo::init(tag);
    let _c0 = repo.commit("f.txt", "base\n", "c0");
    let path = repo.path();

    std::fs::write(repo.dir.join("f.txt"), "stashed change\n").unwrap();
    let saved = stash_save(path.clone(), None, Some(false));
    assert!(saved.ok, "stash_save failed: {}", saved.message);
    assert!(repo.is_clean());

    let _c1 = repo.commit("f.txt", "conflicting commit\n", "c1");
    (repo, path)
}

#[test]
fn stash_apply_conflict_is_recognized_by_the_shared_resolver_as_op_stash() {
    let (repo, path) = build_stash_conflict_repo("workdir_stash_conflict_op");

    let applied = stash_apply(path.clone(), 0, None);
    assert!(!applied.ok, "expected a conflict");
    assert_eq!(repo.open().state(), RepositoryState::Clean, "stash apply/pop never sets MERGE_HEAD");

    let status = conflict_status(path.clone()).expect("conflict_status failed");
    assert!(status.in_progress);
    assert_eq!(status.op, "stash", "a Clean-state conflict with unmerged paths must report op \"stash\"");
    assert_eq!(status.files.len(), 1);
    assert_eq!(status.files[0].path, "f.txt");
}

#[test]
fn stash_apply_conflict_abort_restores_pre_conflict_tree_and_keeps_the_stash() {
    let (repo, path) = build_stash_conflict_repo("workdir_stash_apply_abort");

    let applied = stash_apply(path.clone(), 0, None);
    assert!(!applied.ok);
    assert_eq!(applied.conflicted_files, vec!["f.txt".to_string()]);

    let aborted = stash_conflict_abort(path.clone());
    assert!(aborted.ok, "stash_conflict_abort failed: {}", aborted.message);
    assert_eq!(aborted.state, "clean");
    assert!(repo.is_clean(), "abort should restore a clean tree");
    assert_eq!(repo.read("f.txt"), "conflicting commit\n", "abort should restore the pre-apply content");
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    // The stash entry is untouched by Abort.
    let list = stash_list(path.clone()).expect("stash_list failed");
    assert_eq!(list.len(), 1, "abort must not touch the stash entry");

    // conflict_status is clean again.
    let status = conflict_status(path).expect("conflict_status failed");
    assert!(!status.in_progress);
}

#[test]
fn stash_apply_conflict_continue_resolves_and_keeps_the_stash_entry() {
    let (repo, path) = build_stash_conflict_repo("workdir_stash_apply_continue");

    let applied = stash_apply(path.clone(), 0, None);
    assert!(!applied.ok);

    let resolved = resolve_conflict_file(path.clone(), "f.txt".into(), "theirs".into());
    assert!(resolved.ok, "resolve_conflict_file failed: {}", resolved.message);
    assert_eq!(resolved.remaining, 0);

    let cont = stash_conflict_continue(path.clone());
    assert!(cont.ok, "stash_conflict_continue failed: {}", cont.message);
    assert_eq!(cont.state, "clean");
    // NOTE: the tree is NOT expected to be byte-clean here — exactly like a
    // normal, non-conflicted `stash_apply` (see
    // `stash_save_list_apply_pop_drop_full_lifecycle`'s "Apply re-dirties the
    // tree" case), the resolved content is left staged (resolve_conflict_file
    // staged it), not auto-committed the way merge/rebase's Continue does.
    assert_eq!(repo.read("f.txt"), "stashed change\n", "\"theirs\" (the stash's own content) should have been kept");
    assert_eq!(repo.must(&["diff", "--name-only", "--diff-filter=U"]), "", "no unmerged paths should remain");
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    // Apply's own entry is NEVER dropped, even after a successful continue.
    let list = stash_list(path.clone()).expect("stash_list failed");
    assert_eq!(list.len(), 1, "a stash APPLY's entry must never be dropped, conflict or not");

    let status = conflict_status(path).expect("conflict_status failed");
    assert!(!status.in_progress);
}

#[test]
fn stash_pop_conflict_abort_restores_pre_conflict_tree_and_keeps_the_stash() {
    let (repo, path) = build_stash_conflict_repo("workdir_stash_pop_abort");

    let popped = stash_pop(path.clone(), 0, None);
    assert!(!popped.ok, "expected a conflict");
    assert_eq!(popped.conflicted_files, vec!["f.txt".to_string()]);

    // Per git's own behavior, a CONFLICTED pop never drops the stash entry.
    let list_mid = stash_list(path.clone()).expect("stash_list failed");
    assert_eq!(list_mid.len(), 1, "a conflicted pop must not have dropped the stash entry yet");

    let aborted = stash_conflict_abort(path.clone());
    assert!(aborted.ok, "stash_conflict_abort failed: {}", aborted.message);
    assert!(repo.is_clean());
    assert_eq!(repo.read("f.txt"), "conflicting commit\n");

    // Abort must not drop the stash entry either — it was never touched.
    let list = stash_list(path).expect("stash_list failed");
    assert_eq!(list.len(), 1, "abort must keep the popped-but-conflicted stash entry");
}

#[test]
fn stash_pop_conflict_continue_resolves_and_drops_the_stash_entry() {
    let (repo, path) = build_stash_conflict_repo("workdir_stash_pop_continue");

    let popped = stash_pop(path.clone(), 0, None);
    assert!(!popped.ok, "expected a conflict");

    let resolved = resolve_conflict_file(path.clone(), "f.txt".into(), "theirs".into());
    assert!(resolved.ok, "resolve_conflict_file failed: {}", resolved.message);
    assert_eq!(resolved.remaining, 0);

    let cont = stash_conflict_continue(path.clone());
    assert!(cont.ok, "stash_conflict_continue failed: {}", cont.message);
    assert_eq!(cont.state, "clean");
    // NOTE: not byte-clean — see the sibling apply test's comment.
    assert_eq!(repo.read("f.txt"), "stashed change\n", "\"theirs\" (the stash's own content) should have been kept");
    assert_eq!(repo.must(&["diff", "--name-only", "--diff-filter=U"]), "", "no unmerged paths should remain");
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    // NOW (only once the resolution is actually kept) the popped entry is
    // dropped — this is the behavior that must NOT happen eagerly inside
    // apply_or_pop itself (a conflicted pop never drops it there).
    let list = stash_list(path.clone()).expect("stash_list failed");
    assert!(list.is_empty(), "a stash POP's entry must be dropped once its conflict is actually resolved");

    let status = conflict_status(path).expect("conflict_status failed");
    assert!(!status.in_progress);
}

#[test]
fn stash_conflict_continue_refuses_while_files_remain_unresolved() {
    let (_repo, path) = build_stash_conflict_repo("workdir_stash_continue_still_conflicted");

    let applied = stash_apply(path.clone(), 0, None);
    assert!(!applied.ok);

    let cont = stash_conflict_continue(path.clone());
    assert!(!cont.ok, "continue must refuse while conflicts remain");
    assert_eq!(cont.state, "conflict");
    assert_eq!(cont.conflicted_files, vec!["f.txt".to_string()]);
}

// ---------------------------------------------------------------------------
// Finding #8: an UNSTAGED RENAME must be discardable (it silently no-op'd
// with "No unstaged changes to discard" before the fix).
// ---------------------------------------------------------------------------

#[test]
fn discard_file_reverses_an_unstaged_rename() {
    let repo = TempRepo::init("workdir_discard_rename");
    let _c0 = repo.commit("old.txt", "content\n", "c0");
    let path = repo.path();

    // Rename ON DISK ONLY — never staged (no `git mv`, no `git add`).
    std::fs::rename(repo.dir.join("old.txt"), repo.dir.join("new.txt")).unwrap();
    let status = workdir_status(path.clone()).unwrap();
    assert_eq!(status.unstaged.len(), 1);
    assert_eq!(status.unstaged[0].path, "new.txt");
    assert_eq!(status.unstaged[0].status, "R");
    assert_eq!(status.unstaged[0].old_path.as_deref(), Some("old.txt"));

    let res = discard_file(path.clone(), "new.txt".into(), false);
    assert!(res.ok, "discard_file must reverse an unstaged rename, not no-op: {}", res.message);

    assert!(repo.dir.join("old.txt").exists(), "old_path should be restored");
    assert!(!repo.dir.join("new.txt").exists(), "new_path should be removed");
    assert_eq!(repo.read("old.txt"), "content\n");
    assert!(repo.is_clean(), "tree should be clean again after reversing the rename");

    // A backup of the (never-staged) new path's bytes was written first.
    let backup_rel = res.backup_patch.expect("expected a backup_patch path");
    let full_path = repo.open().path().join(&backup_rel);
    assert_eq!(std::fs::read_to_string(&full_path).unwrap(), "content\n");
}

// ---------------------------------------------------------------------------
// Finding #10: validate_pathspec must align with conflict.rs::validate_path —
// reject only NUL/CR/LF, not every control character (e.g. a legitimate tab).
// ---------------------------------------------------------------------------

#[test]
fn stage_file_accepts_a_tab_containing_filename() {
    let repo = TempRepo::init("workdir_tab_filename");
    let _c0 = repo.commit("keep.txt", "0\n", "c0");
    let path = repo.path();

    let name = "a\tb.txt";
    std::fs::write(repo.dir.join(name), "content\n").unwrap();

    let res = stage_file(path.clone(), name.into());
    assert!(res.ok, "a tab-containing filename must be accepted (matches conflict.rs::validate_path), got: {}", res.message);

    let status = workdir_status(path).unwrap();
    assert!(status.staged.iter().any(|e| e.path == name), "the tab-named file should be staged");
}
