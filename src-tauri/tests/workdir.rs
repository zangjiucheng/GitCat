//! Working tree: status, stage/unstage, discard, commit, and stash (model
//! after tests/branch_ops.rs / tests/merge.rs). Calls the plain Rust functions
//! directly (bypassing Tauri IPC), on a throwaway `TempRepo`.

mod common;

use common::TempRepo;
use git2::RepositoryState;
use gitcat_lib::conflict::{conflict_status, resolve_conflict_file};
use gitcat_lib::git_write::checkout;
use gitcat_lib::model::DiffHunkRow;
use gitcat_lib::safety::{list_snapshots, undo};
use gitcat_lib::workdir::{
    commit, discard_file, discard_lines, stage_all, stage_file, stage_lines, stash_apply,
    stash_conflict_abort, stash_conflict_continue, stash_drop, stash_list, stash_pop, stash_save,
    stash_undo_apply, unstage_file, unstage_lines, workdir_file_diff, workdir_status, HunkSelection,
    SelectedLine,
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

    let status = tauri::async_runtime::block_on(workdir_status(path)).expect("workdir_status failed");
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

    let snaps_before = tauri::async_runtime::block_on(list_snapshots(path.clone())).expect("list_snapshots failed");

    let staged = tauri::async_runtime::block_on(stage_file(path.clone(), "f.txt".into()));
    assert!(staged.ok, "stage_file failed: {}", staged.message);
    assert!(staged.backup_ref.is_none(), "stage_file must not snapshot");

    let status = tauri::async_runtime::block_on(workdir_status(path.clone())).unwrap();
    assert_eq!(status.staged.len(), 1);
    assert_eq!(status.staged[0].path, "f.txt");
    assert_eq!(status.staged[0].status, "M");
    assert!(status.unstaged.is_empty());

    let unstaged = tauri::async_runtime::block_on(unstage_file(path.clone(), "f.txt".into()));
    assert!(unstaged.ok, "unstage_file failed: {}", unstaged.message);
    assert!(unstaged.backup_ref.is_none(), "unstage_file must not snapshot");

    let status = tauri::async_runtime::block_on(workdir_status(path.clone())).unwrap();
    assert!(status.staged.is_empty());
    assert_eq!(status.unstaged.len(), 1);
    assert_eq!(status.unstaged[0].path, "f.txt");

    // Regression test for the "no snapshot flood" policy: the snapshot count
    // must be UNCHANGED across both calls.
    let snaps_after = tauri::async_runtime::block_on(list_snapshots(path)).expect("list_snapshots failed");
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

    let res = tauri::async_runtime::block_on(stage_all(path.clone()));
    assert!(res.ok, "stage_all failed: {}", res.message);
    assert!(res.backup_ref.is_none(), "stage_all must not snapshot");

    let status = tauri::async_runtime::block_on(workdir_status(path)).unwrap();
    assert!(status.unstaged.is_empty());
    assert_eq!(status.staged.len(), 3);
}

#[test]
fn discard_file_restores_tracked_content_and_writes_a_patch_backup() {
    let repo = TempRepo::init("workdir_discard_tracked");
    let _c0 = repo.commit("f.txt", "original\n", "c0");
    let path = repo.path();
    std::fs::write(repo.dir.join("f.txt"), "changed\n").unwrap();

    let res = tauri::async_runtime::block_on(discard_file(path.clone(), "f.txt".into(), false));
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

    let res = tauri::async_runtime::block_on(discard_file(path.clone(), "scratch.txt".into(), true));
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

    let status = tauri::async_runtime::block_on(workdir_status(path.clone())).unwrap();
    assert_eq!(status.unstaged.len(), 1, "the nested repo should show as ONE untracked entry");
    let entry_path = status.unstaged[0].path.clone();
    assert_eq!(status.unstaged[0].status, "?");

    let res = tauri::async_runtime::block_on(discard_file(path.clone(), entry_path, true));
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

    let res = tauri::async_runtime::block_on(commit(path.clone(), Some("my commit message".into()), None));
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

    let res = tauri::async_runtime::block_on(commit(path.clone(), None, Some(true)));
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

    let res = tauri::async_runtime::block_on(commit(path.clone(), Some("   ".into()), None));
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

    let saved = tauri::async_runtime::block_on(stash_save(path.clone(), Some("my stash".into()), Some(false)));
    assert!(saved.ok, "stash_save failed: {}", saved.message);
    assert!(saved.backup_ref.is_some(), "stash_save should snapshot first");
    assert!(repo.is_clean(), "working tree should be clean after stash push");

    let list = tauri::async_runtime::block_on(stash_list(path.clone())).expect("stash_list failed");
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].index, 0);
    assert_eq!(list[0].branch.as_deref(), Some("main"));

    // Apply re-dirties the tree AND keeps the stash entry.
    let applied = tauri::async_runtime::block_on(stash_apply(path.clone(), 0, None));
    assert!(applied.ok, "stash_apply failed: {}", applied.message);
    assert_eq!(repo.read("f.txt"), "dirty\n");
    let list_after_apply = tauri::async_runtime::block_on(stash_list(path.clone())).expect("stash_list failed");
    assert_eq!(list_after_apply.len(), 1, "apply must not drop the stash entry");

    // Clean up again for pop.
    repo.must(&["checkout", "--", "f.txt"]);
    assert!(repo.is_clean());

    let popped = tauri::async_runtime::block_on(stash_pop(path.clone(), 0, None));
    assert!(popped.ok, "stash_pop failed: {}", popped.message);
    assert_eq!(repo.read("f.txt"), "dirty\n");
    let list_after_pop = tauri::async_runtime::block_on(stash_list(path.clone())).expect("stash_list failed");
    assert!(list_after_pop.is_empty(), "pop should drop the stash entry");

    // One more save + explicit drop.
    let saved2 = tauri::async_runtime::block_on(stash_save(path.clone(), None, Some(false)));
    assert!(saved2.ok, "second stash_save failed: {}", saved2.message);
    let dropped = tauri::async_runtime::block_on(stash_drop(path.clone(), 0, None));
    assert!(dropped.ok, "stash_drop failed: {}", dropped.message);
    assert!(dropped.backup_ref.is_some(), "stash_drop should snapshot first");

    let list_final = tauri::async_runtime::block_on(stash_list(path.clone())).expect("stash_list failed");
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
    let saved = tauri::async_runtime::block_on(stash_save(path.clone(), None, Some(false)));
    assert!(saved.ok, "stash_save failed: {}", saved.message);
    assert!(repo.is_clean());

    // Commit a conflicting edit to the SAME line on top of HEAD.
    let _c1 = repo.commit("f.txt", "conflicting commit\n", "c1");

    let applied = tauri::async_runtime::block_on(stash_apply(path.clone(), 0, None));
    assert!(!applied.ok, "expected stash_apply to hit a conflict");
    assert_eq!(applied.conflicted_files, vec!["f.txt".to_string()]);
    assert!(applied.backup_ref.is_some(), "stash_apply should have snapshotted before attempting");

    // Nothing lost: the stash entry is still there.
    let list = tauri::async_runtime::block_on(stash_list(path.clone())).expect("stash_list failed");
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
    let saved = tauri::async_runtime::block_on(stash_save(path.clone(), None, Some(false)));
    assert!(saved.ok, "stash_save failed: {}", saved.message);
    assert!(repo.is_clean());

    let applied = tauri::async_runtime::block_on(stash_apply(path.clone(), 0, None));
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
    let undone = tauri::async_runtime::block_on(stash_undo_apply(path.clone()));
    assert!(undone.ok, "stash_undo_apply failed: {}", undone.message);
    assert!(repo.is_clean(), "tree should be clean again after re-stashing");
    assert!(undone.backup_ref.is_some(), "stash_undo_apply should snapshot first");

    // Content is preserved (as a NEW stash entry) — nothing lost.
    let list = tauri::async_runtime::block_on(stash_list(path.clone())).expect("stash_list failed");
    assert!(!list.is_empty(), "re-stashed content should appear in the stash list");
}

#[test]
fn stash_undo_apply_refuses_on_an_already_clean_tree() {
    let repo = TempRepo::init("workdir_stash_undo_apply_clean");
    let _c0 = repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();
    assert!(repo.is_clean());

    let res = tauri::async_runtime::block_on(stash_undo_apply(path));
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
    let saved = tauri::async_runtime::block_on(stash_save(path.clone(), None, Some(false)));
    assert!(saved.ok, "stash_save failed: {}", saved.message);

    let stash_sha = repo.must(&["rev-parse", "stash@{0}"]);

    let dropped = tauri::async_runtime::block_on(stash_drop(path.clone(), 0, None));
    assert!(dropped.ok, "stash_drop failed: {}", dropped.message);
    let pin_ref = dropped.dropped_stash_ref.clone().expect("stash_drop must pin the dropped commit");
    assert!(pin_ref.starts_with("refs/gitgui/"), "unexpected pin ref: {pin_ref}");

    // The stash entry itself is gone from `stash list`...
    let list = tauri::async_runtime::block_on(stash_list(path.clone())).expect("stash_list failed");
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

    let res = tauri::async_runtime::block_on(stage_file(path.clone(), "test[1].txt".into()));
    assert!(res.ok, "stage_file failed: {}", res.message);

    let status = tauri::async_runtime::block_on(workdir_status(path)).unwrap();
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

    let diff = tauri::async_runtime::block_on(workdir_file_diff(path.clone(), "test[1].txt".into(), false))
        .expect("workdir_file_diff failed");
    assert_eq!(diff.path, "test[1].txt", "diff must resolve to the exact requested file");

    let res = tauri::async_runtime::block_on(discard_file(path.clone(), "test[1].txt".into(), false));
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
    let saved = tauri::async_runtime::block_on(stash_save(path.clone(), None, Some(false)));
    assert!(saved.ok);
    let list = tauri::async_runtime::block_on(stash_list(path.clone())).expect("stash_list failed");
    let real_sha = list[0].sha.clone();

    // A stale/forged sha must be refused BEFORE anything is mutated.
    let res = tauri::async_runtime::block_on(stash_apply(path.clone(), 0, Some("deadbeef".into())));
    assert!(!res.ok, "stash_apply must refuse when expected_sha does not match");
    assert!(res.backup_ref.is_none(), "a refused, never-attempted apply must not have snapshotted");
    assert!(repo.is_clean(), "a refused apply must not have touched the working tree");

    // The CORRECT sha succeeds normally.
    let ok_res = tauri::async_runtime::block_on(stash_apply(path.clone(), 0, Some(real_sha)));
    assert!(ok_res.ok, "stash_apply with the correct expected_sha should succeed: {}", ok_res.message);
}

#[test]
fn stash_drop_refuses_when_expected_sha_does_not_match() {
    let repo = TempRepo::init("workdir_stash_drop_identity");
    let _c0 = repo.commit("f.txt", "0\n", "c0");
    let path = repo.path();

    std::fs::write(repo.dir.join("f.txt"), "dirty\n").unwrap();
    let saved = tauri::async_runtime::block_on(stash_save(path.clone(), None, Some(false)));
    assert!(saved.ok);

    let res = tauri::async_runtime::block_on(stash_drop(path.clone(), 0, Some("deadbeef".into())));
    assert!(!res.ok, "stash_drop must refuse when expected_sha does not match");
    let list = tauri::async_runtime::block_on(stash_list(path.clone())).expect("stash_list failed");
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
    let saved = tauri::async_runtime::block_on(stash_save(path.clone(), None, Some(false)));
    assert!(saved.ok, "stash_save failed: {}", saved.message);
    assert!(repo.is_clean());

    let _c1 = repo.commit("f.txt", "conflicting commit\n", "c1");
    (repo, path)
}

#[test]
fn stash_apply_conflict_is_recognized_by_the_shared_resolver_as_op_stash() {
    let (repo, path) = build_stash_conflict_repo("workdir_stash_conflict_op");

    let applied = tauri::async_runtime::block_on(stash_apply(path.clone(), 0, None));
    assert!(!applied.ok, "expected a conflict");
    assert_eq!(repo.open().state(), RepositoryState::Clean, "stash apply/pop never sets MERGE_HEAD");

    let status = tauri::async_runtime::block_on(conflict_status(path.clone())).expect("conflict_status failed");
    assert!(status.in_progress);
    assert_eq!(status.op, "stash", "a Clean-state conflict with unmerged paths must report op \"stash\"");
    assert_eq!(status.files.len(), 1);
    assert_eq!(status.files[0].path, "f.txt");
}

#[test]
fn stash_apply_conflict_abort_restores_pre_conflict_tree_and_keeps_the_stash() {
    let (repo, path) = build_stash_conflict_repo("workdir_stash_apply_abort");

    let applied = tauri::async_runtime::block_on(stash_apply(path.clone(), 0, None));
    assert!(!applied.ok);
    assert_eq!(applied.conflicted_files, vec!["f.txt".to_string()]);

    let aborted = tauri::async_runtime::block_on(stash_conflict_abort(path.clone()));
    assert!(aborted.ok, "stash_conflict_abort failed: {}", aborted.message);
    assert_eq!(aborted.state, "clean");
    assert!(repo.is_clean(), "abort should restore a clean tree");
    assert_eq!(repo.read("f.txt"), "conflicting commit\n", "abort should restore the pre-apply content");
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    // The stash entry is untouched by Abort.
    let list = tauri::async_runtime::block_on(stash_list(path.clone())).expect("stash_list failed");
    assert_eq!(list.len(), 1, "abort must not touch the stash entry");

    // conflict_status is clean again.
    let status = tauri::async_runtime::block_on(conflict_status(path)).expect("conflict_status failed");
    assert!(!status.in_progress);
}

#[test]
fn stash_apply_conflict_continue_resolves_and_keeps_the_stash_entry() {
    let (repo, path) = build_stash_conflict_repo("workdir_stash_apply_continue");

    let applied = tauri::async_runtime::block_on(stash_apply(path.clone(), 0, None));
    assert!(!applied.ok);

    let resolved = tauri::async_runtime::block_on(resolve_conflict_file(path.clone(), "f.txt".into(), "theirs".into()));
    assert!(resolved.ok, "resolve_conflict_file failed: {}", resolved.message);
    assert_eq!(resolved.remaining, 0);

    let cont = tauri::async_runtime::block_on(stash_conflict_continue(path.clone()));
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
    let list = tauri::async_runtime::block_on(stash_list(path.clone())).expect("stash_list failed");
    assert_eq!(list.len(), 1, "a stash APPLY's entry must never be dropped, conflict or not");

    let status = tauri::async_runtime::block_on(conflict_status(path)).expect("conflict_status failed");
    assert!(!status.in_progress);
}

#[test]
fn stash_pop_conflict_abort_restores_pre_conflict_tree_and_keeps_the_stash() {
    let (repo, path) = build_stash_conflict_repo("workdir_stash_pop_abort");

    let popped = tauri::async_runtime::block_on(stash_pop(path.clone(), 0, None));
    assert!(!popped.ok, "expected a conflict");
    assert_eq!(popped.conflicted_files, vec!["f.txt".to_string()]);

    // Per git's own behavior, a CONFLICTED pop never drops the stash entry.
    let list_mid = tauri::async_runtime::block_on(stash_list(path.clone())).expect("stash_list failed");
    assert_eq!(list_mid.len(), 1, "a conflicted pop must not have dropped the stash entry yet");

    let aborted = tauri::async_runtime::block_on(stash_conflict_abort(path.clone()));
    assert!(aborted.ok, "stash_conflict_abort failed: {}", aborted.message);
    assert!(repo.is_clean());
    assert_eq!(repo.read("f.txt"), "conflicting commit\n");

    // Abort must not drop the stash entry either — it was never touched.
    let list = tauri::async_runtime::block_on(stash_list(path)).expect("stash_list failed");
    assert_eq!(list.len(), 1, "abort must keep the popped-but-conflicted stash entry");
}

#[test]
fn stash_pop_conflict_continue_resolves_and_drops_the_stash_entry() {
    let (repo, path) = build_stash_conflict_repo("workdir_stash_pop_continue");

    let popped = tauri::async_runtime::block_on(stash_pop(path.clone(), 0, None));
    assert!(!popped.ok, "expected a conflict");

    let resolved = tauri::async_runtime::block_on(resolve_conflict_file(path.clone(), "f.txt".into(), "theirs".into()));
    assert!(resolved.ok, "resolve_conflict_file failed: {}", resolved.message);
    assert_eq!(resolved.remaining, 0);

    let cont = tauri::async_runtime::block_on(stash_conflict_continue(path.clone()));
    assert!(cont.ok, "stash_conflict_continue failed: {}", cont.message);
    assert_eq!(cont.state, "clean");
    // NOTE: not byte-clean — see the sibling apply test's comment.
    assert_eq!(repo.read("f.txt"), "stashed change\n", "\"theirs\" (the stash's own content) should have been kept");
    assert_eq!(repo.must(&["diff", "--name-only", "--diff-filter=U"]), "", "no unmerged paths should remain");
    assert_eq!(repo.open().state(), RepositoryState::Clean);

    // NOW (only once the resolution is actually kept) the popped entry is
    // dropped — this is the behavior that must NOT happen eagerly inside
    // apply_or_pop itself (a conflicted pop never drops it there).
    let list = tauri::async_runtime::block_on(stash_list(path.clone())).expect("stash_list failed");
    assert!(list.is_empty(), "a stash POP's entry must be dropped once its conflict is actually resolved");

    let status = tauri::async_runtime::block_on(conflict_status(path)).expect("conflict_status failed");
    assert!(!status.in_progress);
}

#[test]
fn stash_conflict_continue_refuses_while_files_remain_unresolved() {
    let (_repo, path) = build_stash_conflict_repo("workdir_stash_continue_still_conflicted");

    let applied = tauri::async_runtime::block_on(stash_apply(path.clone(), 0, None));
    assert!(!applied.ok);

    let cont = tauri::async_runtime::block_on(stash_conflict_continue(path.clone()));
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
    let status = tauri::async_runtime::block_on(workdir_status(path.clone())).unwrap();
    assert_eq!(status.unstaged.len(), 1);
    assert_eq!(status.unstaged[0].path, "new.txt");
    assert_eq!(status.unstaged[0].status, "R");
    assert_eq!(status.unstaged[0].old_path.as_deref(), Some("old.txt"));

    let res = tauri::async_runtime::block_on(discard_file(path.clone(), "new.txt".into(), false));
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

    let res = tauri::async_runtime::block_on(stage_file(path.clone(), name.into()));
    assert!(res.ok, "a tab-containing filename must be accepted (matches conflict.rs::validate_path), got: {}", res.message);

    let status = tauri::async_runtime::block_on(workdir_status(path)).unwrap();
    assert!(status.staged.iter().any(|e| e.path == name), "the tab-named file should be staged");
}

// ---------------------------------------------------------------------------
// Hunk/line-level staging: stage_lines / unstage_lines / discard_lines.
// `apply_selected_lines`/`build_sub_patch` (workdir.rs) reconstruct a
// sub-patch covering only the caller-selected `+`/`-` rows and apply it with
// `git apply`; these tests drive that end to end (never construct a patch by
// hand — exactly like the real frontend, a `HunkSelection` is built from
// whatever `workdir_file_diff` just returned).
// ---------------------------------------------------------------------------

/// Build a `HunkSelection` for `hunk`, keeping only the `+`/`-` lines that
/// satisfy `pred(old_no, new_no)` — mirrors the frontend's
/// `buildSelectedHunks()` (workdir.svelte.ts): a flat predicate over the
/// hunk's own lines, grouped back into one `HunkSelection`.
fn select_lines(hunk: &DiffHunkRow, pred: impl Fn(Option<u32>, Option<u32>) -> bool) -> HunkSelection {
    HunkSelection {
        header: hunk.header.clone(),
        lines: hunk
            .lines
            .iter()
            .filter(|l| (l.kind == "+" || l.kind == "-") && pred(l.old_no, l.new_no))
            .map(|l| SelectedLine { kind: l.kind.clone(), old_no: l.old_no, new_no: l.new_no })
            .collect(),
    }
}

/// Ten-line baseline used by several tests below: `a1`..`a10`, one per line.
fn ten_lines() -> Vec<String> {
    (1..=10).map(|i| format!("a{i}\n")).collect()
}

#[test]
fn stage_lines_stages_only_the_selected_line_pair_leaving_the_other_modification_unstaged() {
    let repo = TempRepo::init("workdir_stage_lines_partial");
    let orig = ten_lines();
    let _c0 = repo.commit("f.txt", &orig.concat(), "c0");
    let path = repo.path();

    // Two separate one-line modifications, close enough together that
    // context_lines(3) merges them into a SINGLE hunk — this is what makes
    // selecting only one of the two pairs a genuine LINE-level (not just
    // hunk-level) test.
    let mut modified = orig.clone();
    modified[1] = "b2\n".to_string(); // line 2
    modified[3] = "b4\n".to_string(); // line 4
    std::fs::write(repo.dir.join("f.txt"), modified.concat()).unwrap();

    let diff = tauri::async_runtime::block_on(workdir_file_diff(path.clone(), "f.txt".into(), false)).expect("workdir_file_diff failed");
    assert_eq!(diff.hunks.len(), 1, "the two nearby edits should merge into one hunk");
    let sel = select_lines(&diff.hunks[0], |old_no, new_no| old_no == Some(2) || new_no == Some(2));
    assert_eq!(sel.lines.len(), 2, "expected exactly the '-'/'+' pair for line 2");

    let res = tauri::async_runtime::block_on(stage_lines(path.clone(), "f.txt".into(), vec![sel]));
    assert!(res.ok, "stage_lines failed: {}", res.message);
    assert!(res.backup_ref.is_none(), "stage_lines is index-only, no snapshot");

    let indexed = repo.must(&["show", ":f.txt"]);
    assert!(indexed.contains("b2"), "index should carry the staged line-2 change:\n{indexed}");
    assert!(!indexed.contains("b4"), "index must NOT carry line-4's still-unstaged change:\n{indexed}");
    assert!(indexed.contains("a4"), "line-4's original content should remain in the index:\n{indexed}");

    // Staging never touches the working tree.
    assert!(repo.read("f.txt").contains("b2"));
    assert!(repo.read("f.txt").contains("b4"));

    let status = tauri::async_runtime::block_on(workdir_status(path)).unwrap();
    assert_eq!(status.staged.len(), 1, "line 2's change should be staged");
    assert_eq!(status.staged[0].path, "f.txt");
    assert_eq!(status.staged[0].status, "M");
    assert_eq!(status.unstaged.len(), 1, "line 4's change should still be unstaged");
    assert_eq!(status.unstaged[0].path, "f.txt");
}

#[test]
fn unstage_lines_unstages_only_the_selected_line_pair_leaving_the_other_staged() {
    let repo = TempRepo::init("workdir_unstage_lines_partial");
    let orig = ten_lines();
    let _c0 = repo.commit("f.txt", &orig.concat(), "c0");
    let path = repo.path();

    let mut modified = orig.clone();
    modified[1] = "b2\n".to_string();
    modified[3] = "b4\n".to_string();
    std::fs::write(repo.dir.join("f.txt"), modified.concat()).unwrap();
    repo.must(&["add", "-A"]); // both changes fully staged

    let diff = tauri::async_runtime::block_on(workdir_file_diff(path.clone(), "f.txt".into(), true)).expect("workdir_file_diff (staged) failed");
    assert_eq!(diff.hunks.len(), 1);
    let sel = select_lines(&diff.hunks[0], |old_no, new_no| old_no == Some(2) || new_no == Some(2));

    let res = tauri::async_runtime::block_on(unstage_lines(path.clone(), "f.txt".into(), vec![sel]));
    assert!(res.ok, "unstage_lines failed: {}", res.message);
    assert!(res.backup_ref.is_none(), "unstage_lines is index-only, no snapshot");

    let indexed = repo.must(&["show", ":f.txt"]);
    assert!(indexed.contains("a2"), "line 2 should be back to its ORIGINAL content in the index:\n{indexed}");
    assert!(indexed.contains("b4"), "line 4's change should remain staged:\n{indexed}");

    // Unstaging never touches the working tree.
    assert!(repo.read("f.txt").contains("b2"));
    assert!(repo.read("f.txt").contains("b4"));

    let status = tauri::async_runtime::block_on(workdir_status(path)).unwrap();
    assert_eq!(status.staged.len(), 1, "line 4's change should still be staged");
    assert_eq!(status.staged[0].path, "f.txt");
    assert_eq!(status.unstaged.len(), 1, "line 2's change should be unstaged again");
    assert_eq!(status.unstaged[0].path, "f.txt");
}

#[test]
fn discard_lines_discards_only_the_selected_line_pair_and_backs_up_the_whole_file_first() {
    let repo = TempRepo::init("workdir_discard_lines_partial");
    let orig = ten_lines();
    let _c0 = repo.commit("f.txt", &orig.concat(), "c0");
    let path = repo.path();

    let mut modified = orig.clone();
    modified[1] = "b2\n".to_string();
    modified[3] = "b4\n".to_string();
    std::fs::write(repo.dir.join("f.txt"), modified.concat()).unwrap();

    let diff = tauri::async_runtime::block_on(workdir_file_diff(path.clone(), "f.txt".into(), false)).expect("workdir_file_diff failed");
    let sel = select_lines(&diff.hunks[0], |old_no, new_no| old_no == Some(2) || new_no == Some(2));

    let res = tauri::async_runtime::block_on(discard_lines(path.clone(), "f.txt".into(), vec![sel]));
    assert!(res.ok, "discard_lines failed: {}", res.message);

    let content = repo.read("f.txt");
    assert!(content.contains("a2"), "line 2 should be discarded back to its original content:\n{content}");
    assert!(!content.contains("b2"), "line 2's edit must be gone from the working tree:\n{content}");
    assert!(content.contains("b4"), "line 4's edit should survive (not selected for discard):\n{content}");

    // Index is untouched by a discard.
    let indexed = repo.must(&["show", ":f.txt"]);
    assert!(indexed.contains("a2") && indexed.contains("a4"), "index should be untouched: {indexed}");

    let status = tauri::async_runtime::block_on(workdir_status(path)).unwrap();
    assert!(status.staged.is_empty());
    assert_eq!(status.unstaged.len(), 1, "line 4's surviving edit should still show as unstaged");
    assert_eq!(status.unstaged[0].path, "f.txt");

    // A whole-file backup was written first (superset of what was discarded).
    let backup_rel = res.backup_patch.expect("expected a backup_patch path");
    let full_path = repo.open().path().join(&backup_rel);
    let patch_contents = std::fs::read_to_string(&full_path).unwrap();
    assert!(patch_contents.contains("+b2") && patch_contents.contains("+b4"), "backup must cover BOTH edits, not just the discarded one: {patch_contents}");
}

#[test]
fn stage_lines_on_a_brand_new_untracked_file_stages_only_the_selected_added_lines() {
    let repo = TempRepo::init("workdir_stage_lines_new_file");
    let _c0 = repo.commit("keep.txt", "0\n", "c0");
    let path = repo.path();

    std::fs::write(repo.dir.join("new.txt"), "one\ntwo\nthree\nfour\n").unwrap();

    let diff = tauri::async_runtime::block_on(workdir_file_diff(path.clone(), "new.txt".into(), false)).expect("workdir_file_diff failed");
    assert_eq!(diff.status, "A");
    assert_eq!(diff.hunks.len(), 1);
    let sel = select_lines(&diff.hunks[0], |_old_no, new_no| matches!(new_no, Some(1) | Some(2)));
    assert_eq!(sel.lines.len(), 2);

    let res = tauri::async_runtime::block_on(stage_lines(path.clone(), "new.txt".into(), vec![sel]));
    assert!(res.ok, "stage_lines on a new file failed: {}", res.message);

    let indexed = repo.must(&["show", ":new.txt"]);
    assert_eq!(indexed, "one\ntwo", "index should hold only the two selected added lines");

    // The working tree copy is untouched — all four lines still present.
    assert_eq!(repo.read("new.txt"), "one\ntwo\nthree\nfour\n");

    let status = tauri::async_runtime::block_on(workdir_status(path)).unwrap();
    assert_eq!(status.staged.len(), 1);
    assert_eq!(status.staged[0].path, "new.txt");
    assert_eq!(status.staged[0].status, "A", "the file is new to HEAD, so it's still an ADD even though only partially staged");
    assert_eq!(status.unstaged.len(), 1, "the two un-staged trailing lines should show as a pending modification");
    assert_eq!(status.unstaged[0].path, "new.txt");
    assert_eq!(status.unstaged[0].status, "M", "no longer '?': the file is now known to the index");
}

#[test]
fn stage_lines_on_a_brand_new_untracked_file_with_every_line_selected_stages_the_whole_file_as_added() {
    let repo = TempRepo::init("workdir_stage_lines_new_file_full");
    let _c0 = repo.commit("keep.txt", "0\n", "c0");
    let path = repo.path();

    std::fs::write(repo.dir.join("new.txt"), "one\ntwo\n").unwrap();

    let diff = tauri::async_runtime::block_on(workdir_file_diff(path.clone(), "new.txt".into(), false)).expect("workdir_file_diff failed");
    let sel = select_lines(&diff.hunks[0], |_old_no, _new_no| true); // every added line

    let res = tauri::async_runtime::block_on(stage_lines(path.clone(), "new.txt".into(), vec![sel]));
    assert!(res.ok, "stage_lines (full new file) failed: {}", res.message);

    let indexed = repo.must(&["show", ":new.txt"]);
    assert_eq!(indexed, "one\ntwo");

    let status = tauri::async_runtime::block_on(workdir_status(path)).unwrap();
    assert_eq!(status.staged.len(), 1);
    assert_eq!(status.staged[0].path, "new.txt");
    assert_eq!(status.staged[0].status, "A");
    assert!(status.unstaged.is_empty(), "nothing left unstaged once every added line is staged");
}

#[test]
fn stage_lines_on_a_fully_deleted_tracked_file_can_partially_restage_as_a_modification() {
    let repo = TempRepo::init("workdir_stage_lines_partial_delete");
    let orig = ten_lines();
    let _c0 = repo.commit("d.txt", &orig.concat(), "c0");
    let path = repo.path();

    std::fs::remove_file(repo.dir.join("d.txt")).unwrap();
    let diff = tauri::async_runtime::block_on(workdir_file_diff(path.clone(), "d.txt".into(), false)).expect("workdir_file_diff failed");
    assert_eq!(diff.status, "D");
    assert_eq!(diff.hunks.len(), 1);

    // Select only the first TWO removed lines — a partial delete.
    let sel = select_lines(&diff.hunks[0], |old_no, _new_no| matches!(old_no, Some(1) | Some(2)));
    assert_eq!(sel.lines.len(), 2);

    let res = tauri::async_runtime::block_on(stage_lines(path.clone(), "d.txt".into(), vec![sel]));
    assert!(res.ok, "stage_lines (partial delete) failed: {}", res.message);

    let indexed = repo.must(&["show", ":d.txt"]);
    assert_eq!(indexed, orig[2..].concat().trim_end(), "index should keep lines 3..10, only 1-2 removed");

    let status = tauri::async_runtime::block_on(workdir_status(path)).unwrap();
    assert_eq!(status.staged.len(), 1);
    assert_eq!(status.staged[0].path, "d.txt");
    assert_eq!(status.staged[0].status, "M", "a PARTIAL delete leaves the file present -> modification, not D");
    assert_eq!(status.unstaged.len(), 1, "the working tree still has no file at all, vs the now-shorter index");
    assert_eq!(status.unstaged[0].path, "d.txt");
    assert_eq!(status.unstaged[0].status, "D");
}

#[test]
fn stage_lines_refuses_the_whole_request_when_a_hunk_header_no_longer_matches() {
    let repo = TempRepo::init("workdir_stage_lines_stale");
    let orig = ten_lines();
    let _c0 = repo.commit("f.txt", &orig.concat(), "c0");
    let path = repo.path();
    let mut modified = orig.clone();
    modified[1] = "b2\n".to_string();
    std::fs::write(repo.dir.join("f.txt"), modified.concat()).unwrap();

    let stale = HunkSelection {
        header: "@@ -999,1 +999,1 @@".to_string(), // does not match the real (current) hunk header
        lines: vec![SelectedLine { kind: "+".to_string(), old_no: None, new_no: Some(2) }],
    };
    let res = tauri::async_runtime::block_on(stage_lines(path.clone(), "f.txt".into(), vec![stale]));
    assert!(!res.ok, "a stale/mismatched hunk header must be refused, not silently reinterpreted");
    assert!(
        res.message.contains("changed since you last looked"),
        "expected the staleness message, got: {}",
        res.message
    );

    // Nothing should have been staged.
    let status = tauri::async_runtime::block_on(workdir_status(path)).unwrap();
    assert!(status.staged.is_empty(), "a refused request must not partially apply");
}

#[test]
fn stage_lines_refuses_on_a_binary_file() {
    let repo = TempRepo::init("workdir_stage_lines_binary");
    std::fs::write(repo.dir.join("bin.dat"), [0u8, 1, 2, 3, 0, 4]).unwrap();
    repo.must(&["add", "-A"]);
    repo.must(&["commit", "-q", "--no-verify", "-m", "c0"]);
    let path = repo.path();
    std::fs::write(repo.dir.join("bin.dat"), [0u8, 9, 9, 9, 0, 4, 5]).unwrap();

    // `workdir_file_diff` returns no hunks at all for a binary file, so a
    // caller has nothing real to build a `HunkSelection` from — any non-empty
    // one targeting the file's path must still be refused with the binary
    // message (this check must run before header validation, since there is
    // no valid header to check against).
    let diff = tauri::async_runtime::block_on(workdir_file_diff(path.clone(), "bin.dat".into(), false)).expect("workdir_file_diff failed");
    assert!(diff.binary);
    assert!(diff.hunks.is_empty());

    let bogus = HunkSelection {
        header: "@@ -1,1 +1,1 @@".to_string(),
        lines: vec![SelectedLine { kind: "+".to_string(), old_no: None, new_no: Some(1) }],
    };
    let res = tauri::async_runtime::block_on(stage_lines(path.clone(), "bin.dat".into(), vec![bogus]));
    assert!(!res.ok, "line-level staging on a binary file must be refused");
    assert!(res.message.contains("binary file"), "expected a binary-file message, got: {}", res.message);
}

#[test]
fn stage_lines_preserves_a_final_line_with_no_trailing_newline() {
    let repo = TempRepo::init("workdir_stage_lines_no_eof_newline");
    std::fs::write(repo.dir.join("f.txt"), "a1\na2\na3").unwrap(); // no trailing newline
    repo.must(&["add", "-A"]);
    repo.must(&["commit", "-q", "--no-verify", "-m", "c0"]);
    let path = repo.path();

    std::fs::write(repo.dir.join("f.txt"), "a1\na2\na3-changed").unwrap(); // still no trailing newline

    let diff = tauri::async_runtime::block_on(workdir_file_diff(path.clone(), "f.txt".into(), false)).expect("workdir_file_diff failed");
    assert_eq!(diff.hunks.len(), 1);
    let sel = select_lines(&diff.hunks[0], |_old_no, _new_no| true); // the whole (only) hunk

    let res = tauri::async_runtime::block_on(stage_lines(path.clone(), "f.txt".into(), vec![sel]));
    assert!(res.ok, "stage_lines failed on a no-trailing-newline file: {}", res.message);

    let indexed = repo.must(&["show", ":f.txt"]);
    assert_eq!(indexed, "a1\na2\na3-changed", "content (and lack of trailing newline) must round-trip exactly");
}

/// Regression test: a PARTIAL selection touching a no-trailing-newline hunk
/// used to be genuinely dangerous, not just rejected — EMPIRICALLY VERIFIED
/// by hand against a real `git apply` outside this test suite: keeping the
/// demoted line's own marker produces a patch git accepts but silently
/// concatenates two lines with no separator ("a3" + "a3-changed" ->
/// "a3a3-changed", no error at all); dropping the marker instead produces a
/// patch git cleanly refuses. Neither is safe for a partial selection, so
/// `build_sub_patch` now refuses the whole request up front instead — this
/// test is what actually caught that corruption during review and must keep
/// failing loudly if the guard is ever removed.
#[test]
fn stage_lines_refuses_a_partial_selection_of_a_final_no_trailing_newline_line() {
    let repo = TempRepo::init("workdir_stage_lines_no_eof_newline_partial");
    std::fs::write(repo.dir.join("f.txt"), "a1\na2\na3").unwrap(); // no trailing newline
    repo.must(&["add", "-A"]);
    repo.must(&["commit", "-q", "--no-verify", "-m", "c0"]);
    let path = repo.path();

    std::fs::write(repo.dir.join("f.txt"), "a1\na2\na3-changed").unwrap(); // still no trailing newline

    let diff = tauri::async_runtime::block_on(workdir_file_diff(path.clone(), "f.txt".into(), false)).expect("workdir_file_diff failed");
    assert_eq!(diff.hunks.len(), 1);
    // Only the "+" half of the modified last line — NOT the whole hunk.
    let sel = select_lines(&diff.hunks[0], |_old_no, new_no| new_no == Some(3));
    assert_eq!(sel.lines.len(), 1, "expected exactly the '+' line for the new final line");

    let res = tauri::async_runtime::block_on(stage_lines(path.clone(), "f.txt".into(), vec![sel]));
    assert!(!res.ok, "a partial selection touching a no-trailing-newline boundary must be refused, not silently applied");
    assert!(
        res.message.contains("newline"),
        "refusal message should explain why (mentions newline): {}",
        res.message
    );

    // Nothing was touched — no corruption, no partial stage.
    assert_eq!(repo.read("f.txt"), "a1\na2\na3-changed");
    let status = tauri::async_runtime::block_on(workdir_status(path)).unwrap();
    assert!(status.staged.is_empty(), "refused request must not have staged anything");
}

/// Regression test for the `covers_full_add` fix: `unstage_lines` on a
/// brand-new file that was staged IN FULL (so it's `Delta::Added` against
/// HEAD, not `Delta::Untracked`), unstaging only SOME of its lines.
/// EMPIRICALLY VERIFIED this used to fail with git's own "depends on old
/// contents" error before `covers_full_add` existed, because the header
/// unconditionally claimed the whole file was being un-added even though
/// only part of it was.
#[test]
fn unstage_lines_can_partially_unstage_a_fully_staged_new_file() {
    let repo = TempRepo::init("workdir_unstage_lines_added_partial");
    let _c0 = repo.commit("keep.txt", "0\n", "c0");
    let path = repo.path();

    // A brand-new file, staged in full — Delta::Added vs HEAD, not Untracked.
    std::fs::write(repo.dir.join("new.txt"), "n1\nn2\nn3\nn4\n").unwrap();
    repo.must(&["add", "--", "new.txt"]);

    let diff = tauri::async_runtime::block_on(workdir_file_diff(path.clone(), "new.txt".into(), true)).expect("workdir_file_diff failed (staged side)");
    assert_eq!(diff.hunks.len(), 1);
    // Unstage only n2/n4, leaving n1/n3 staged.
    let sel = select_lines(&diff.hunks[0], |_old_no, new_no| new_no == Some(2) || new_no == Some(4));
    assert_eq!(sel.lines.len(), 2);

    let res = tauri::async_runtime::block_on(unstage_lines(path.clone(), "new.txt".into(), vec![sel]));
    assert!(res.ok, "unstage_lines failed on a partial selection of a fully-staged new file: {}", res.message);
    assert!(res.backup_ref.is_none(), "unstage_lines is index-only, no snapshot");

    let indexed = repo.must(&["show", ":new.txt"]);
    assert_eq!(indexed, "n1\nn3", "index should keep only the still-staged lines"); // repo.must() trims trailing whitespace

    // The working tree is untouched by unstage — all four lines remain.
    assert_eq!(repo.read("new.txt"), "n1\nn2\nn3\nn4\n");

    let status = tauri::async_runtime::block_on(workdir_status(path)).unwrap();
    assert_eq!(status.staged.len(), 1, "n1/n3 should still be staged as (a smaller) new file");
    assert_eq!(status.staged[0].path, "new.txt");
    assert_eq!(status.unstaged.len(), 1, "n2/n4 should now show as unstaged additions");
    assert_eq!(status.unstaged[0].path, "new.txt");
}

/// Regression test for the `covers_full_rename` fix: `unstage_lines` on a
/// renamed-AND-modified file that's staged in full, unstaging only SOME of
/// its content lines. EMPIRICALLY VERIFIED this used to silently revert the
/// WHOLE rename in the index (git ls-files showing old.txt again, not just
/// new.txt with fewer staged edits) even though only two content lines were
/// requested — the rename header must be dropped for a partial selection,
/// exactly like the `covers_full_add`/`covers_full_delete` fixes one level up.
#[test]
fn unstage_lines_on_a_renamed_and_modified_file_preserves_the_rename() {
    let repo = TempRepo::init("workdir_unstage_lines_rename_partial");
    let orig = ten_lines();
    let _c0 = repo.commit("old.txt", &orig.concat(), "c0");
    let path = repo.path();

    repo.must(&["mv", "old.txt", "new.txt"]);
    let mut modified = orig.clone();
    modified[1] = "b2\n".to_string(); // line 2
    modified[3] = "b4\n".to_string(); // line 4
    std::fs::write(repo.dir.join("new.txt"), modified.concat()).unwrap();
    repo.must(&["add", "-A"]);

    // Confirm the setup is really a detected rename before testing anything.
    let pre_status = tauri::async_runtime::block_on(workdir_status(path.clone())).unwrap();
    assert_eq!(pre_status.staged.len(), 1);
    assert_eq!(pre_status.staged[0].path, "new.txt");
    assert_eq!(pre_status.staged[0].status, "R");
    assert_eq!(pre_status.staged[0].old_path.as_deref(), Some("old.txt"));

    let diff = tauri::async_runtime::block_on(workdir_file_diff(path.clone(), "new.txt".into(), true)).expect("workdir_file_diff failed (staged side)");
    assert_eq!(diff.hunks.len(), 1, "the two nearby edits should merge into one hunk");
    // Unstage only line 2's pair, leaving line 4's edit staged.
    let sel = select_lines(&diff.hunks[0], |old_no, new_no| old_no == Some(2) || new_no == Some(2));
    assert_eq!(sel.lines.len(), 2);

    let res = tauri::async_runtime::block_on(unstage_lines(path.clone(), "new.txt".into(), vec![sel]));
    assert!(res.ok, "unstage_lines failed on a partial selection of a renamed+modified file: {}", res.message);

    // The rename must survive — this is the actual regression check.
    let tracked_paths = repo.must(&["ls-files"]);
    assert!(tracked_paths.contains("new.txt"), "the file must still be at its renamed path:\n{tracked_paths}");
    assert!(!tracked_paths.contains("old.txt"), "the rename must not have been silently reverted:\n{tracked_paths}");

    let indexed = repo.must(&["show", ":new.txt"]);
    assert!(indexed.contains("a2"), "line 2's edit should now be unstaged (back to a2 in the index):\n{indexed}");
    assert!(indexed.contains("b4"), "line 4's edit should remain staged:\n{indexed}");

    let status = tauri::async_runtime::block_on(workdir_status(path)).unwrap();
    assert_eq!(status.staged.len(), 1, "the (still-renamed) file should still show one staged entry");
    assert_eq!(status.staged[0].path, "new.txt");
    assert_eq!(status.staged[0].status, "R", "git's own similarity detection should still call this a rename");
    assert_eq!(status.staged[0].old_path.as_deref(), Some("old.txt"));
    assert_eq!(status.unstaged.len(), 1, "line 2's now-unstaged edit should show up separately");
    assert_eq!(status.unstaged[0].path, "new.txt");
}

// ---------------------------------------------------------------------------
// Backlog #34 (checkout dirty-tree resolution modes): the untracked-restore/
// auto-drop gap. Mode 1 ("stash, switch, reapply") systematically triggers a
// shape where an untracked stash entry collides with a path the target
// branch's checkout makes TRACKED — `git stash pop` then fails with its own
// stable "could not restore untracked files from stash" and (empirically
// verified) leaves the stash entry fully intact. When this coincides with a
// REAL index conflict in some OTHER file, `stash_conflict_continue` must NOT
// auto-drop the stash once that index conflict is resolved — the untracked
// content is the ONLY remaining copy, and dropping it would destroy it.
// ---------------------------------------------------------------------------

#[test]
fn stash_conflict_continue_keeps_the_stash_when_an_untracked_restore_also_failed() {
    let repo = TempRepo::init("workdir_stash_untracked_restore_gap");
    let _c0 = repo.commit("a.txt", "base\n", "c0");
    let _c1 = repo.commit("x.txt", "base\n", "c1: add x.txt");
    let path = repo.path();

    // feature: changes BOTH a.txt and x.txt (x.txt stays tracked there).
    repo.must(&["switch", "-q", "-c", "feature"]);
    repo.commit("a.txt", "feature line\n", "feature changes a.txt");
    repo.commit("x.txt", "feature x content\n", "feature changes x.txt");
    repo.must(&["switch", "-q", "main"]);

    // main: x.txt is removed from TRACKING (so it's tracked on feature but not
    // main), then a DIFFERENT untracked x.txt appears at that same path — the
    // exact shape that makes a later `stash pop` onto feature unable to
    // restore it (feature's checkout already put a tracked x.txt there).
    repo.must(&["rm", "-q", "x.txt"]);
    repo.must(&["commit", "-q", "-m", "main removes x.txt from tracking"]);
    std::fs::write(
        repo.dir.join("x.txt"),
        "untracked content for x on main, differs from feature\n",
    )
    .unwrap();
    // Also dirty a.txt (unstaged), so popping onto feature ALSO hits a real
    // index conflict there, independent of x.txt's untracked-restore failure.
    std::fs::write(repo.dir.join("a.txt"), "base\nmain-side change to a\n").unwrap();
    assert!(!repo.is_clean());

    let saved = tauri::async_runtime::block_on(stash_save(path.clone(), Some("pre-switch".into()), Some(true)));
    assert!(saved.ok, "stash_save (with untracked) failed: {}", saved.message);
    assert!(repo.is_clean());

    let co = tauri::async_runtime::block_on(checkout(path.clone(), "feature".into()));
    assert!(co.ok, "checkout to feature failed: {}", co.message);

    let popped = tauri::async_runtime::block_on(stash_pop(path.clone(), 0, None));
    assert!(!popped.ok, "expected the pop to hit a real index conflict on a.txt");
    assert_eq!(popped.conflicted_files, vec!["a.txt".to_string()]);
    // git's own behavior on ANY failed pop: the stash entry is kept.
    let list = tauri::async_runtime::block_on(stash_list(path.clone())).expect("stash_list failed");
    assert_eq!(list.len(), 1, "a failed pop must never drop the stash entry");

    // Resolve the a.txt conflict and stage it.
    std::fs::write(repo.dir.join("a.txt"), "resolved\n").unwrap();
    let staged = tauri::async_runtime::block_on(stage_file(path.clone(), "a.txt".into()));
    assert!(staged.ok, "stage_file failed: {}", staged.message);

    let cont = tauri::async_runtime::block_on(stash_conflict_continue(path.clone()));
    assert!(cont.ok, "stash_conflict_continue failed: {}", cont.message);
    assert_eq!(cont.state, "clean");
    assert!(
        cont.message.to_lowercase().contains("kept") && cont.message.to_lowercase().contains("not dropped"),
        "expected the message to explain the stash was deliberately kept, not dropped: {}",
        cont.message
    );

    // THE regression check: the stash must NOT have been auto-dropped, since
    // part of it (the untracked x.txt) could never be restored and would
    // otherwise be permanently lost by the normal pop-success auto-drop.
    let list_after = tauri::async_runtime::block_on(stash_list(path.clone())).expect("stash_list failed");
    assert_eq!(
        list_after.len(),
        1,
        "the stash entry must be KEPT, not auto-dropped, when an untracked restore also failed"
    );
}

/// Sanity companion: WITHOUT any coinciding index conflict, an
/// untracked-restore failure alone is deliberately left as a standalone,
/// less-guided-but-safe degrade (see `apply_or_pop`'s own doc comment on
/// this scope decision) — `stash_pop` surfaces `ok:false` with
/// `conflicted_files` empty (not the Resolver-shaped conflict path), and the
/// stash entry is still kept by git itself.
#[test]
fn stash_pop_untracked_restore_failure_alone_is_a_plain_error_with_stash_kept() {
    let repo = TempRepo::init("workdir_stash_untracked_restore_standalone");
    let _c0 = repo.commit("a.txt", "base\n", "c0");
    let _c1 = repo.commit("x.txt", "base\n", "c1: add x.txt");
    let path = repo.path();

    repo.must(&["switch", "-q", "-c", "feature"]);
    repo.commit("x.txt", "feature x content\n", "feature changes x.txt");
    repo.must(&["switch", "-q", "main"]);

    repo.must(&["rm", "-q", "x.txt"]);
    repo.must(&["commit", "-q", "-m", "main removes x.txt from tracking"]);
    std::fs::write(repo.dir.join("x.txt"), "untracked content on main\n").unwrap();

    let saved = tauri::async_runtime::block_on(stash_save(path.clone(), Some("pre-switch".into()), Some(true)));
    assert!(saved.ok, "stash_save (with untracked) failed: {}", saved.message);
    assert!(repo.is_clean());

    let co = tauri::async_runtime::block_on(checkout(path.clone(), "feature".into()));
    assert!(co.ok, "checkout to feature failed: {}", co.message);

    let popped = tauri::async_runtime::block_on(stash_pop(path.clone(), 0, None));
    assert!(!popped.ok, "expected the pop to fail (untracked restore collision)");
    assert!(
        popped.conflicted_files.is_empty(),
        "no index conflict here — must not be routed through the Resolver's conflict path"
    );
    assert!(
        popped.message.to_lowercase().contains("could not restore untracked files from stash"),
        "expected git's own stable message forwarded verbatim: {}",
        popped.message
    );

    let list = tauri::async_runtime::block_on(stash_list(path.clone())).expect("stash_list failed");
    assert_eq!(list.len(), 1, "git itself keeps the stash entry when it can't restore untracked files");
}
